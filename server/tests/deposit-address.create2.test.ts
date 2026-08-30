import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import path from 'path';
import fs from 'fs';

describe('CREATE2 Deterministic Address Derivation', () => {
    it('A. TypeScript-derived address == Solidity Factory predicted address', async () => {
        const contractsDir = path.resolve(__dirname, '../../contracts');
        const factoryArtifactPath = path.join(contractsDir, 'artifacts/contracts/Factory.sol/Factory.json');
        const forwarderArtifactPath = path.join(contractsDir, 'artifacts/contracts/Forwarder.sol/Forwarder.json');
        if (!fs.existsSync(factoryArtifactPath) || !fs.existsSync(forwarderArtifactPath)) {
            console.warn('ENVIRONMENT BLOCKED: Contracts not compiled. Skipping on-chain exact match test.');
            return;
        }
        const factoryArtifact = JSON.parse(fs.readFileSync(factoryArtifactPath, 'utf8'));
        const forwarderArtifact = JSON.parse(fs.readFileSync(forwarderArtifactPath, 'utf8'));
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        let deployer;
        try {
            deployer = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
            await provider.getNetwork();
        } catch (e) {
            console.warn('ENVIRONMENT BLOCKED: Local hardhat node not running (npx hardhat node). Skipping on-chain exact match test.');
            return;
        }
        const forwarderFactory = new ethers.ContractFactory(forwarderArtifact.abi, forwarderArtifact.bytecode, deployer);
        const forwarder = await forwarderFactory.deploy(deployer.address);
        await forwarder.waitForDeployment();
        const implementationAddress = await forwarder.getAddress();
        const factoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, deployer);
        const factory = await factoryFactory.deploy(implementationAddress);
        await factory.waitForDeployment();
        const factoryAddress = await factory.getAddress();
        const userId = 'user-123';
        const network = 'ETHEREUM';
        const salt = ethers.keccak256(ethers.solidityPacked(['string', 'string'], [userId, network]));
        const predictedBySolidity = await factory.predictDeterministicAddress(salt);
        const expectedInitCode = ethers.solidityPacked(['bytes', 'bytes20', 'bytes'], ['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementationAddress, '0x5af43d82803e903d91602b57fd5bf3']);
        const expectedInitCodeHash = ethers.keccak256(expectedInitCode);
        const predictedByTypescript = ethers.getCreate2Address(factoryAddress, salt, expectedInitCodeHash);
        expect(predictedByTypescript.toLowerCase()).toBe(predictedBySolidity.toLowerCase());
    });
});
