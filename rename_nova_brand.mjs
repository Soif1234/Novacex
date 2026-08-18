import fs from 'fs';

const replacements = [
  {
    file: 'src/pages/Account.tsx',
    find: 'About NovaCEX',
    replace: 'About Mallick Exchange'
  },
  {
    file: 'src/pages/Login.tsx',
    find: 'demo@novacex.com',
    replace: 'demo@mallickexchange.com',
    global: true
  },
  {
    file: 'src/pages/Login.tsx',
    find: 'Welcome to NovaCEX',
    replace: 'Welcome to Mallick Exchange'
  },
  {
    file: 'src/pages/Home.tsx',
    find: '>NovaCEX<',
    replace: '>Mallick Exchange<'
  },
  {
    file: 'src/contexts/AuthContext.tsx',
    find: '>NovaCEX<',
    replace: '>Mallick Exchange<'
  },
  {
    file: 'metadata.json',
    find: '"NovaCEX"',
    replace: '"Mallick Exchange"'
  },
  {
    file: 'src/services/user/UserService.ts',
    find: 'demo@novacex.com',
    replace: 'demo@mallickexchange.com',
    global: true
  },
  {
    file: 'index.html',
    find: '<title>My Google AI Studio App</title>',
    replace: '<title>Mallick Exchange</title>'
  },
  {
    file: 'index.html',
    find: 'content="My Google AI Studio App"',
    replace: 'content="Mallick Exchange"'
  }
];

let replacedCount = 0;

for (const rep of replacements) {
  if (fs.existsSync(rep.file)) {
    let content = fs.readFileSync(rep.file, 'utf8');
    let newContent;
    if (rep.global) {
      newContent = content.split(rep.find).join(rep.replace);
    } else {
      newContent = content.replace(rep.find, rep.replace);
    }
    if (newContent !== content) {
      fs.writeFileSync(rep.file, newContent);
      console.log('Updated:', rep.file, '->', rep.find);
      replacedCount++;
    }
  }
}
console.log(`Replaced in ${replacedCount} locations.`);
