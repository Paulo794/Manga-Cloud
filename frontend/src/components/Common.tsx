import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import type { Manga } from '../domain';

export function Notice({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'notice-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}
export function MangaCard({ manga }: { manga: Manga }) {
  return <Link className="manga-card" to={`/mangas/${manga.provider}/${manga.id}`}>
    <div className="cover">{manga.coverUrl ? <img src={manga.coverUrl} alt={`Capa de ${manga.title}`} loading="lazy" /> : <span>SEM CAPA</span>}<span className="source-tag">{manga.isDemo ? 'DEMO' : manga.provider === 'anilist' ? 'ANILIST' : 'MANGADEX'}</span></div>
    <h3>{manga.title}</h3><p>{manga.tags.slice(0, 2).map(t => t.name).join(' · ') || 'Mangá'}</p>
  </Link>;
}
export function PrivateImage({ url, alt }: { url: string; alt: string }) {
  const [image, setImage] = useState({ url: '', src: '' });
  useEffect(() => {
    let cancelled = false, objectUrl = '';
    api.get(url.replace(/^\/api/, ''), { responseType: 'blob' }).then(r => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(r.data); setImage({ url, src: objectUrl });
    }).catch(() => {});
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);
  const src = image.url === url ? image.src : '';
  return src ? <img className="private-image" src={src} alt={alt} /> : <div className="image-placeholder" aria-label={alt}>MC</div>;
}
