const fs = require('fs');
let code = fs.readFileSync('src/pages/Futures.tsx', 'utf8');

if (!code.includes("const [sliderPercentage, setSliderPercentage] = useState(0);")) {
  code = code.replace(
    "const [quantityInput, setQuantityInput] = useState('');",
    `const [quantityInput, setQuantityInput] = useState('');\n  const [sliderPercentage, setSliderPercentage] = useState(0);`
  );
  fs.writeFileSync('src/pages/Futures.tsx', code);
}
