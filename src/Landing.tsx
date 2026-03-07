import { useState, useRef, useEffect } from 'react';
import './Landing.css';

export default function Landing() {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = new Audio('/nyc-ambient.mp3');
    audio.loop = true;
    audio.volume = 0.35;
    audioRef.current = audio;
    return () => { audio.pause(); audio.src = ''; };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play().catch(() => {});
    }
    setPlaying(!playing);
  };

  return (
    <div className="landing" onClick={!playing ? toggle : undefined}>
      <div className="landing-content">
        <div className="landing-crane">🏗️</div>
        <div className="landing-text">coming soon</div>
      </div>
      <button className="landing-audio" onClick={(e) => { e.stopPropagation(); toggle(); }}>
        {playing ? '◉ LIVE' : '○ LISTEN'}
      </button>
      {!playing && (
        <div className="landing-hint">tap anywhere to listen</div>
      )}
    </div>
  );
}
