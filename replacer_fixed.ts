import fs from 'fs';

let content = fs.readFileSync('src/Dashboard.tsx', 'utf-8');
const searchReturn = `  return (
    <div className="h-screen bg-[#050510]`;
const splitIdx = content.indexOf(searchReturn);

if (splitIdx !== -1) {
    const rawJSX = fs.readFileSync('payload2.txt', 'utf-8');
    content = content.substring(0, splitIdx) + rawJSX + "\n}\n";
    fs.writeFileSync('src/Dashboard.tsx', content);
    console.log("Success");
} else {
    console.log("Failed to find return marker");
}
