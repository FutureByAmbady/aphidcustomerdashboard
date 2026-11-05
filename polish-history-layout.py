from pathlib import Path
import shutil
from datetime import datetime

root = Path(r'C:\SmartInsectDetector\AphidCustomerDashboard')
css = root / 'frontend/src/styles.css'
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copy2(css, Path(str(css) + f'.backup-{stamp}'))
app = root / 'frontend/src/App.jsx'
shutil.copy2(app, Path(str(app) + f'.backup-{stamp}'))
s = css.read_text(encoding='utf-8-sig')
app_text = app.read_text(encoding='utf-8-sig')
app_text = app_text.replace('Â°', '°').replace('â€”', '—').replace('â€¦', '…')
app.write_text(app_text, encoding='utf-8', newline='\n')
addon = r'''
/* Refined history layout */
.history-grid { grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr); gap: 18px; }
.history-grid .panel { padding: 22px; }
.history-grid .panel-heading { margin-bottom: 16px; }
.recent-list { margin: 0 -22px -22px; }
.recent-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) 45px 92px max-content; gap: 12px; min-height: 76px; padding: 10px 22px; align-items: center; }
.recent-row .image-frame { width: 56px; height: 52px; border-radius: 10px; }
.recent-time { min-width: 0; gap: 3px; }
.recent-time strong { overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.recent-time span, .recent-count span { font-size: 10px; }
.recent-count { min-width: 0; gap: 2px; text-align: right; }
.recent-count strong { font-size: 15px; }
.record-status { min-width: 0; overflow: hidden; font-size: 10px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.image-links.compact { min-width: 0; flex-direction: column; align-items: flex-end; gap: 2px; }
.image-links.compact .view-link { font-size: 10px; line-height: 1.25; white-space: nowrap; }
.wind-table { min-width: 0; table-layout: fixed; }
.wind-table th, .wind-table td { padding: 9px 6px; }
.wind-table th:first-child, .wind-table td:first-child { width: 35%; }
.wind-table th:nth-child(2), .wind-table td:nth-child(2) { width: 22%; }
.wind-table th:nth-child(n+3), .wind-table td:nth-child(n+3) { width: 14.3%; }
@media (max-width: 640px) {
  .history-grid .panel { padding: 17px; }
  .recent-list { margin: 0 -17px -17px; }
  .recent-row { grid-template-columns: 52px minmax(0, 1fr) 42px; gap: 9px; padding: 10px 17px; }
  .recent-row .record-status { grid-column: 2; text-align: left; }
  .recent-row .image-links.compact { grid-column: 3; grid-row: 1 / span 2; }
  .recent-row .image-frame { width: 52px; height: 48px; }
}
'''
if '/* Refined history layout */' not in s:
    css.write_text(s.rstrip() + '\n' + addon, encoding='utf-8', newline='\n')
print('History layout polished. Backup:', css.name + f'.backup-{stamp}')
