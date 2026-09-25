from pathlib import Path
import shutil, re
from datetime import datetime

p = Path(r'C:\SmartInsectDetector\AphidCustomerDashboard\frontend\src\App.jsx')
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
shutil.copy2(p, Path(str(p) + f'.backup-{stamp}'))
s = p.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
open_marker = '''      {!rows.length ? <EmptyState message="No wind readings available for this period." /> : (
        <div className="wind-table-wrap">'''
open_replacement = '''      {!rows.length ? <EmptyState message="No wind readings available for this period." /> : (
        <>
        <div className="wind-table-wrap">'''
if s.count(open_marker) != 1:
    raise SystemExit('Wind history opening block not found exactly once.')
s = s.replace(open_marker, open_replacement, 1)
pattern = r'''(        \{hasMore && <div className="history-more">.*?</div>\})\n      \)}\n    </section>\n  \);\n}\n\nfunction RecentDetections'''
replacement = r'''\1
        </>
      )}
    </section>
  );
}

function RecentDetections'''
s2, count = re.subn(pattern, replacement, s, count=1, flags=re.S)
if count != 1:
    raise SystemExit('Wind history closing block not found.')
p.write_text(s2, encoding='utf-8', newline='\n')
print('Fixed JSX fragment. Backup:', p.name + f'.backup-{stamp}')
