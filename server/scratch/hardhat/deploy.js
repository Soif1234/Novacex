const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

async function main() {
  const sourceCode = fs.readFileSync(path.join(__dirname, 'contracts', 'MockSafe.sol'), 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'MockSafe.sol': {
        content: sourceCode,
      },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  
  const contract = output.contracts['MockSafe.sol']['MockSafe'];
  const abi = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  const provider = new ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');
  // First account from Ganache
  const signer = new ethers.Wallet('0xba1cc0d37b934bdc7cfcfa23f947a7a0f87a08fd2da9ce37f53591db37d238e9', provider);

  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const safe = await factory.deploy(signer.address, 1);
  await safe.deployed();

  console.log('Deployed MockSafe to:', safe.address);
  console.log('Owner address:', signer.address);

  fs.writeFileSync('deployed.json', JSON.stringify({
    safeAddress: safe.address,
    ownerAddress: signer.address,
    chainId: 1337
  }, null, 2));
}

main().catch(console.error);
