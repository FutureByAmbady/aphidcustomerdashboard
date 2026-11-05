export function ImageFrame({ detection, large = false }) {
  const imageUrl = detection?.result_image_url || detection?.original_image_url || detection?.image_url;
  if (!imageUrl) return <div className={`image-frame unavailable ${large ? "large" : ""}`}>Image unavailable</div>;
  const label = detection?.result_image_url ? "Detection result" : "Original image";
  return <div className={`image-frame ${large ? "large" : ""}`}><img src={imageUrl} alt={label} loading={large ? "eager" : "lazy"} onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement.classList.add("unavailable"); event.currentTarget.parentElement.append("Image unavailable"); }} /></div>;
}

export function ImageLinks({ detection, compact = false }) {
  const links = [];
  if (detection?.result_image_url) links.push({ label: "View result", url: detection.result_image_url });
  if (detection?.original_image_url && detection.original_image_url !== detection.result_image_url) links.push({ label: "View original", url: detection.original_image_url });
  if (!links.length && detection?.image_url) links.push({ label: "View image", url: detection.image_url });
  if (!links.length) return null;
  return <div className={`image-links ${compact ? "compact" : ""}`}>{links.map((link) => <a key={link.label} className={compact ? "view-link" : "primary-button"} href={link.url} target="_blank" rel="noreferrer" aria-label={link.label}>{link.label}</a>)}</div>;
}
