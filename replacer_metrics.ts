import fs from 'fs';

let content = fs.readFileSync('src/Dashboard.tsx', 'utf-8');

// Replace lucide-react imports
const importRegex = /import {([^}]+)} from 'lucide-react';/;
if (importRegex.test(content)) {
  const match = content.match(importRegex);
  if (match) {
    let imports = match[1].split(',').map(s => s.trim());
    const needed = ['Activity', 'Hexagon', 'Download', 'FileText', 'TrendingUp', 'Shield', 'Sliders', 'GitBranch'];
    needed.forEach(n => {
      if (!imports.includes(n)) imports.push(n);
    });
    content = content.replace(importRegex, `import { ${imports.join(', ')} } from 'lucide-react';`);
  }
} else {
  content = `import { Activity, Hexagon, Download, FileText, TrendingUp, Shield, Sliders, GitBranch } from 'lucide-react';\n` + content;
}

let startIdx = content.indexOf('key="metrics"');
if (startIdx !== -1) {
  startIdx = content.lastIndexOf('<motion.div', startIdx);
}

if (startIdx !== -1) {
  const searchStart = content.substring(startIdx);
  const endIdx = searchStart.indexOf('          </AnimatePresence>');
  
  if (endIdx !== -1) {
    const rawJSX = fs.readFileSync('payload_metrics.txt', 'utf-8');
    content = content.substring(0, startIdx) + rawJSX + "\n            )}\\n          </AnimatePresence>" + searchStart.substring(endIdx + 28);
    // Note: I will just use </AnimatePresence> since it's the next closing tag for that block
    fs.writeFileSync('src/Dashboard.tsx', content);
    console.log("Success");
  } else {
    // maybe try to find exit tag
    const fallBackIdx = searchStart.indexOf('</AnimatePresence>');
    if (fallBackIdx !== -1) {
       let tempIdx = searchStart.lastIndexOf('</motion.div>', fallBackIdx);
       const rawJSX = fs.readFileSync('payload_metrics.txt', 'utf-8');
       content = content.substring(0, startIdx) + rawJSX + "\n            )}\n          </AnimatePresence>" + searchStart.substring(fallBackIdx + 18);
       fs.writeFileSync('src/Dashboard.tsx', content);
       console.log("Success with fallback");
    } else {
       console.log("Failed to find end marker for metrics");
    }
  }
} else {
  console.log("Failed to find start marker for metrics");
}
