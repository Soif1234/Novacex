const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const MockSafe = await hre.ethers.getContractFactory("MockSafe");
  // Set threshold=1 and owner=deployer
  const safe = await MockSafe.deploy(deployer.address, 1);
  await safe.deployed();
  
  console.log(safe.address);
  console.log(deployer.address);
}

main().catch(console.error);
