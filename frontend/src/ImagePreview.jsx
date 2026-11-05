import { useEffect, useState } from 'react';

export function ImageFrame({ detection, large = false }) {
  const [failed, setFailed] = useState([]);
  // A refreshed metadata record can retry a preview whose background upload was pending.
  useEffect(() => setFailed([]), [detection]);
  const preferred = detection?.result_thumbnail_url || detection?.thumbnail_url;
  // A missing result thumbnail may use the original thumbnail, never full size.
  const imageUrl = failed.includes(preferred) && detection?.thumbnail_url !== preferred
    ? detection?.thumbnail_url : preferred;
  const original = detection?.result_image_url || detection?.original_image_url || detection?.image_url;
  const label = detection?.result_image_url ? 'Detection result thumbnail' : 'Original image thumbnail';
  if (!imageUrl || failed.includes(imageUrl)) return <div className={`image-frame unavailable ${large ? 'large' : ''}`}>Preview unavailable{original && <span> — use View image/result to open the original</span>}</div>;
  return <div className={`image-frame ${large ? 'large' : ''}`}><img src={imageUrl} alt={label} loading="lazy" decoding="async" onError={() => setFailed(current => [...current, imageUrl])} /></div>;
}

export function ImageLinks({ detection, compact = false }) {
  const links = [];
  if (detection?.result_image_url) links.push({ label: 'View result', url: detection.result_image_url });
  if (detection?.original_image_url && detection.original_image_url !== detection.result_image_url) links.push({ label: 'View original', url: detection.original_image_url });
  if (!links.length && detection?.image_url) links.push({ label: 'View image', url: detection.image_url });
  if (!links.length) return null;
  return <div className={`image-links ${compact ? 'compact' : ''}`}>{links.map(link => <a key={link.label} className={compact ? 'view-link' : 'primary-button'} href={link.url} target="_blank" rel="noreferrer" aria-label={link.label}>{link.label}</a>)}</div>;
}
