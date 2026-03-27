/**
 * Vercel Edge Function — MTA F line GTFS-RT decoder
 * Fetches the BDF/M feed (which includes F), decodes protobuf,
 * returns simplified JSON: [{ tripId, stopId, stopSeq, status, timestamp }]
 *
 * MTA GTFS-RT feeds (no API key required for basic access):
 *   Feed 16 = B D F M lines
 *   https://api-endpoint.mta.info/Feeds/16
 */

export const config = { runtime: 'edge' };

// Minimal protobuf decoder for GTFS-RT VehiclePosition messages
// We only need: trip.trip_id, trip.route_id, vehicle.current_stop_sequence,
//               vehicle.stop_id, vehicle.current_status, vehicle.timestamp
// Full proto spec: https://developers.google.com/transit/gtfs-realtime/reference

function readVarint(buf, pos) {
  let result = 0n, shift = 0n;
  while (pos < buf.length) {
    const b = BigInt(buf[pos++]);
    result |= (b & 0x7fn) << shift;
    shift += 7n;
    if (!(b & 0x80n)) break;
  }
  return { val: result, pos };
}

function readBytes(buf, pos) {
  const { val: len, pos: p } = readVarint(buf, pos);
  const end = p + Number(len);
  return { bytes: buf.slice(p, end), pos: end };
}

function skipField(buf, pos, wireType) {
  switch (wireType) {
    case 0: { const r = readVarint(buf, pos); return r.pos; }
    case 1: return pos + 8;
    case 2: { const r = readBytes(buf, pos); return r.pos; }
    case 5: return pos + 4;
    default: return pos + 1;
  }
}

function parseMessage(buf, parseFn) {
  const result = {};
  let pos = 0;
  while (pos < buf.length) {
    const { val: tag, pos: p } = readVarint(buf, pos);
    pos = p;
    if (pos >= buf.length) break;
    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    parseFn(buf, pos, fieldNum, wireType, result, (newPos) => { pos = newPos; });
  }
  return result;
}

// Parse TripDescriptor (field 1 of VehiclePosition)
// MTA TripDescriptor: field 1=trip_id, field 3=start_date, field 5=route_id
function parseTripDesc(buf) {
  const r = {};
  let pos = 0;
  while (pos < buf.length) {
    const { val: tag, pos: p } = readVarint(buf, pos);
    pos = p;
    if (pos >= buf.length) break;
    const fn = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 2) {
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      if (fn === 1) r.trip_id   = new TextDecoder().decode(bytes);
      if (fn === 5) r.route_id  = new TextDecoder().decode(bytes);
    } else if (wt === 0) {
      const { val, pos: np } = readVarint(buf, pos); pos = np;
      if (fn === 4) r.direction_id = Number(val); // 0=N, 1=S in standard spec
    } else {
      pos = skipField(buf, pos, wt);
    }
  }
  return r;
}

// Parse VehiclePosition (from entity.vehicle)
// MTA uses non-standard field numbers vs GTFS-RT spec:
//   field 1 = trip, field 4 = current_status, field 7 = stop_id, field 8 = current_stop_sequence, field 9 = timestamp
function parseVehiclePos(buf) {
  const r = {};
  let pos = 0;
  while (pos < buf.length) {
    const { val: tag, pos: p } = readVarint(buf, pos);
    pos = p;
    if (pos >= buf.length) break;
    const fn = Number(tag >> 3n), wt = Number(tag & 7n);
    if (fn === 1 && wt === 2) { // trip
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      r.trip = parseTripDesc(bytes);
    } else if (fn === 2 && wt === 2) { // position (skip)
      const { pos: np } = readBytes(buf, pos); pos = np;
    } else if (fn === 4 && wt === 0) { // current_status (MTA field 4)
      const { val, pos: np } = readVarint(buf, pos); pos = np;
      r.current_status = Number(val);
    } else if (fn === 7 && wt === 2) { // stop_id (MTA field 7)
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      r.stop_id = new TextDecoder().decode(bytes);
    } else if (fn === 8 && wt === 0) { // current_stop_sequence (MTA field 8)
      const { val, pos: np } = readVarint(buf, pos); pos = np;
      r.current_stop_sequence = Number(val);
    } else if (fn === 9 && wt === 0) { // timestamp (MTA field 9)
      const { val, pos: np } = readVarint(buf, pos); pos = np;
      r.timestamp = Number(val);
    } else {
      pos = skipField(buf, pos, wt);
    }
  }
  return r;
}

// Parse one FeedEntity
function parseFeedEntity(buf) {
  const r = {};
  let pos = 0;
  while (pos < buf.length) {
    const { val: tag, pos: p } = readVarint(buf, pos);
    pos = p;
    if (pos >= buf.length) break;
    const fn = Number(tag >> 3n), wt = Number(tag & 7n);
    if (fn === 1 && wt === 2) { // id
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      r.id = new TextDecoder().decode(bytes);
    } else if (fn === 4 && wt === 2) { // vehicle
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      r.vehicle = parseVehiclePos(bytes);
    } else {
      pos = skipField(buf, pos, wt);
    }
  }
  return r;
}

// Parse FeedMessage (top level)
function parseFeedMessage(buf) {
  const entities = [];
  let pos = 0;
  while (pos < buf.length) {
    const { val: tag, pos: p } = readVarint(buf, pos);
    pos = p;
    if (pos >= buf.length) break;
    const fn = Number(tag >> 3n), wt = Number(tag & 7n);
    if (fn === 2 && wt === 2) { // entity
      const { bytes, pos: np } = readBytes(buf, pos); pos = np;
      entities.push(parseFeedEntity(bytes));
    } else {
      pos = skipField(buf, pos, wt);
    }
  }
  return entities;
}

export default async function handler(req) {
  try {
    // MTA GTFS-RT BDFM feed (includes F train) — no API key required
    // Must send a browser-like User-Agent; MTA blocks server-side UAs
    const mtaRes = await fetch(
      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
      {
        headers: {
          'Accept': 'application/x-protobuf, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      }
    );

    if (!mtaRes.ok) {
      return new Response(JSON.stringify({ error: `MTA returned ${mtaRes.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const protobuf = new Uint8Array(await mtaRes.arrayBuffer());
    const entities = parseFeedMessage(protobuf);

    // Filter to F trains only
    const fTrains = entities
      .filter(e => e.vehicle?.trip?.route_id === 'F')
      .map(e => {
        const v = e.vehicle;
        return {
          tripId: v.trip?.trip_id ?? '',
          routeId: v.trip?.route_id ?? 'F',
          stopId: v.stop_id ?? '',
          stopSeq: v.current_stop_sequence ?? 0,
          status: v.current_status ?? 2, // 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
          timestamp: v.timestamp ?? 0,
        };
      })
      .filter(t => t.stopId);

    return new Response(JSON.stringify(fTrains), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
