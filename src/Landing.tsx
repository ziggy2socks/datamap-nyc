import { useState, useRef, useEffect } from 'react';
import './Landing.css';

export default function Landing() {
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio('/nyc-ambient.mp3');
    audio.loop = true;
    audio.volume = 0;
    audioRef.current = audio;
    return () => { audio.pause(); audio.src = ''; };
  }, []);

  // Auto-start on first user interaction
  useEffect(() => {
    let fired = false;
    const start = () => {
      if (fired) return;
      fired = true;
      const audio = audioRef.current;
      if (!audio) return;
      audio.play().then(() => {
        setPlaying(true);
        setStarted(true);
        // Fade in to 0.35
        let step = 0;
        const steps = 30;
        const target = 0.35;
        const timer = setInterval(() => {
          step++;
          if (audioRef.current) audioRef.current.volume = Math.min(target, (step / steps) * target);
          if (step >= steps) clearInterval(timer);
        }, 1500 / steps);
      }).catch(() => { fired = false; });
    };
    const events = ['click', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach(e => window.addEventListener(e, start, { passive: true }));
    return () => events.forEach(e => window.removeEventListener(e, start));
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => {});
      audio.volume = 0.35;
      setPlaying(true);
    }
  };

  return (
    <div className="landing">
      <div className="landing-content">
        <div className="landing-crane">🏗️</div>
        <div className="landing-text">coming soon</div>

      </div>
      {started && (
        <button className="landing-audio" onClick={toggle}>
          {playing ? '◉ LIVE' : '○ LISTEN'}
        </button>
      )}
      {!started && (
        <div className="landing-hint">tap anywhere to listen</div>
      )}
    </div>
  );
}
