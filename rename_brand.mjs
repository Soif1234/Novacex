import fs from 'fs';
import path from 'path';

function findFiles(dir, filter, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
        findFiles(filePath, filter, fileList);
      }
    } else if (filter(filePath)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const allFiles = findFiles('./src', (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.css'));
allFiles.push('./index.html');
allFiles.push('./metadata.json');

let replacedCount = 0;
let fileCount = 0;
for (const file of allFiles) {
  let content = fs.readFileSync(file, 'utf8');
  let newContent = content;

  // Perform case-sensitive replacements for the branding terms in UI text
  const regexes = [
    { from: /Nexus CEX Demo Exchange/g, to: 'Mallick Exchange Demo' },
    { from: /Nexus CEX Demo/g, to: 'Mallick Exchange Demo' },
    { from: /Nexus CEX/g, to: 'Mallick Exchange' },
    { from: /NexusCEX/g, to: 'Mallick Exchange' },
    { from: /NEXUS CEX/g, to: 'MALLICK EXCHANGE' }
  ];

  let fileChanged = false;
  for (const r of regexes) {
    let oldContent = newContent;
    newContent = newContent.replace(r.from, r.to);
    if (oldContent !== newContent) {
      fileChanged = true;
    }
  }

  // Also catch generic 'Nexus' where it appears in title/text, but be careful not to break code
  // Mostly targetting <title> in index.html, metadata.json and visible components
  if (file === 'index.html' || file === 'metadata.json' || file.includes('components/') || file.includes('pages/')) {
    let oldContent = newContent;
    newContent = newContent.replace(/>Nexus</g, '>Mallick Exchange<');
    newContent = newContent.replace(/>Nexus\b/g, '>Mallick Exchange');
    newContent = newContent.replace(/"Nexus CEX"/g, '"Mallick Exchange"');
    newContent = newContent.replace(/"Nexus"/g, '"Mallick Exchange"');
    
    if (file === 'metadata.json') {
      newContent = newContent.replace(/"Nexus CEX"/g, '"Mallick Exchange"');
    }
    
    if (oldContent !== newContent) {
      fileChanged = true;
    }
  }
  
  // Specific case for index.html title
  if (file === 'index.html') {
      newContent = newContent.replace(/<title>.*?<\/title>/, '<title>Mallick Exchange</title>');
  }

  if (fileChanged || file === 'index.html') {
    fs.writeFileSync(file, newContent);
    console.log('Modified:', file);
    fileCount++;
    replacedCount++;
  }
}

console.log(`Replaced in ${fileCount} files.`);
