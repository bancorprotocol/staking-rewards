const path = require('path');
const fs = require('fs');

const Contract = require('web3-eth-contract');
const { keccak256, asciiToHex } = require('web3-utils');

const { info, error, warning, arg } = require('./logger');
const Provider = require('./provider');
const { test, init, reorgOffset } = require('./yargs');

const settings = require('../settings.json');
const programs = require('../programs.json');

const LIQUIDITY_PROTECTION = asciiToHex('LiquidityProtection');

let contracts = {};
let web3Provider;

const setup = async () => {
    const setupProvider = async () => {
        web3Provider = new Provider();

        await web3Provider.initialize();
    };

    const setupExternalContracts = async () => {
        const { externalContracts } = settings;

        info('Setting up External Contracts');

        const externalContractsDir = path.resolve(
            __dirname,
            '../../../node_modules/@bancor/contracts/solidity/build/contracts'
        );

        let { abi, address } = externalContracts.LiquidityProtectionStoreOld;
        contracts.LiquidityProtectionStoreOld = new Contract(abi, address);

        ({ address } = externalContracts.TokenGovernance);
        rawData = fs.readFileSync(path.join(externalContractsDir, 'TokenGovernance.json'));
        ({ abi } = JSON.parse(rawData));
        contracts.TokenGovernance = new Contract(abi, address);

        ({ address } = externalContracts.CheckpointStore);
        rawData = fs.readFileSync(path.join(externalContractsDir, 'CheckpointStore.json'));
        ({ abi } = JSON.parse(rawData));
        contracts.CheckpointStore = new Contract(abi, address);

        ({ address } = externalContracts.ContractRegistry);
        rawData = fs.readFileSync(path.join(externalContractsDir, 'ContractRegistry.json'));
        ({ abi } = JSON.parse(rawData));
        contracts.ContractRegistry = new Contract(abi, address);
    };

    const deploySystemContract = async (name, arguments = []) => {
        const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

        info(`Deploying ${name}`);

        const rawData = fs.readFileSync(path.join(systemContractsDir, `${name}.json`));
        const { abi, bytecode } = JSON.parse(rawData);

        const contract = new Contract(abi);
        const instance = await web3Provider.send(contract.deploy({ data: bytecode, arguments }));

        const { address } = instance.options;

        info(`Deployed new ${name} to`, arg('address', address));

        contracts[name] = new Contract(abi, address);
    };

    const registerContract = async (key, contract) => {
        info(`Registering ${contract} in ContractRegistry`);

        const {
            externalContracts: {
                ContractRegistry: { owner }
            }
        } = settings;

        return web3Provider.send(
            contracts.ContractRegistry.methods.registerAddress(key, contracts[contract].options.address),
            { from: owner }
        );
    };

    const grantRole = async (contract, role, name, options = {}) => {
        info(`Granting ${name} the ${role} role on ${contract}`);

        const address = name.startsWith('0x') ? name : contracts[name].options.address;
        return web3Provider.send(contracts[contract].methods.grantRole(keccak256(role), address), options);
    };

    const setupSystemContracts = async () => {
        const { externalContracts, systemContracts } = settings;

        if (init) {
            info('Deploying contracts');

            await deploySystemContract('TestCheckpointStore');
            await deploySystemContract('StakingRewardsStore');
            await deploySystemContract('TestStakingRewards', [
                contracts.StakingRewardsStore.options.address,
                contracts.TokenGovernance.options.address,
                contracts.TestCheckpointStore.options.address,
                externalContracts.ContractRegistry.address
            ]);

            await deploySystemContract('TestLiquidityProtectionDataStore');
            await deploySystemContract('TestLiquidityProtection', [
                contracts.TestLiquidityProtectionDataStore.options.address,
                contracts.TestStakingRewards.options.address,
                contracts.TestCheckpointStore.options.address
            ]);

            info('Registering contracts');

            await registerContract(LIQUIDITY_PROTECTION, 'TestLiquidityProtection');

            info('Granting required permissions');

            await grantRole('StakingRewardsStore', 'ROLE_OWNER', 'TestStakingRewards');
            await grantRole('StakingRewardsStore', 'ROLE_OWNER', web3Provider.getDefaultAccount());
            await grantRole('StakingRewardsStore', 'ROLE_SEEDER', web3Provider.getDefaultAccount());
            await grantRole('TokenGovernance', 'ROLE_MINTER', 'TestStakingRewards', {
                from: externalContracts.TokenGovernance.governor
            });
            await grantRole('CheckpointStore', 'ROLE_SEEDER', web3Provider.getDefaultAccount(), {
                from: externalContracts.CheckpointStore.owner
            });
            await grantRole('TestStakingRewards', 'ROLE_PUBLISHER', 'TestLiquidityProtection');
        } else {
            let { abi, address } = systemContracts.StakingRewardsStore;
            if (abi && address) {
                contracts.StakingRewardsStore = new Contract(abi, address);
            } else {
                warning('Unable to retrieve StakingRewardsStore settings');
            }

            ({ abi, address } = systemContracts.StakingRewards);
            if (abi && address) {
                contracts.StakingRewards = new Contract(abi, address);
            } else {
                warning('Unable to retrieve StakingRewards settings');
            }
        }
    };

    try {
        await setupProvider();
        await setupExternalContracts();
        await setupSystemContracts();

        return {
            settings,
            programs,
            web3Provider,
            contracts,
            reorgOffset,
            test,
            init
        };
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

module.exports = setup;
