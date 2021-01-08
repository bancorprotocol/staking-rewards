const path = require('path');
const fs = require('fs');

const Contract = require('web3-eth-contract');
const { keccak256, asciiToHex } = require('web3-utils');

const { info, error, warning, arg } = require('./logger');
const Provider = require('./provider');
const { test, init, reorgOffset } = require('./yargs');

const settings = require('../settings.json');
const programs = require('../programs.json');

const ROLE_OWNER = keccak256('ROLE_OWNER');
const ROLE_MINTER = keccak256('ROLE_MINTER');
const ROLE_SEEDER = keccak256('ROLE_SEEDER');
const ROLE_PUBLISHER = keccak256('ROLE_PUBLISHER');
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

    const setupSystemContracts = async () => {
        const { externalContracts, systemContracts } = settings;

        if (init) {
            info('Deploying TestStakingRewards');

            const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

            let rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsStore.json'));
            let { abi, bytecode } = JSON.parse(rawData);

            const StakingRewardsStore = new Contract(abi);
            let instance = await web3Provider.send(StakingRewardsStore.deploy({ data: bytecode }));

            const { address: stakingRewardsStoreAddress } = instance.options;

            info('Deployed new StakingRewardsStore to', arg('address', stakingRewardsStoreAddress));

            contracts.StakingRewardsStore = new Contract(abi, stakingRewardsStoreAddress);

            info('Deploying TestStakingRewards');

            rawData = fs.readFileSync(path.join(systemContractsDir, 'TestStakingRewards.json'));
            ({ abi, bytecode } = JSON.parse(rawData));

            const TestStakingRewards = new Contract(abi);
            let arguments = [
                stakingRewardsStoreAddress,
                contracts.TokenGovernance.options.address,
                contracts.CheckpointStore.options.address,
                externalContracts.ContractRegistry.address
            ];

            instance = await web3Provider.send(TestStakingRewards.deploy({ data: bytecode, arguments }));
            const { address: testStakingRewardsAddress } = instance.options;

            info('Deployed new TestStakingRewards to', arg('address', testStakingRewardsAddress));

            contracts.TestStakingRewards = new Contract(abi, testStakingRewardsAddress);

            info('Deploying TestLiquidityProtectionDataStore');

            rawData = fs.readFileSync(path.join(systemContractsDir, 'TestLiquidityProtectionDataStore.json'));
            ({ abi, bytecode } = JSON.parse(rawData));

            const TestLiquidityProtectionDataStore = new Contract(abi);

            instance = await web3Provider.send(TestLiquidityProtectionDataStore.deploy({ data: bytecode }));
            const { address: testLiquidityProtectionDataStoreAddress } = instance.options;

            info(
                'Deployed new TestLiquidityProtectionDataStore to',
                arg('address', testLiquidityProtectionDataStoreAddress)
            );

            contracts.TestLiquidityProtectionDataStore = new Contract(abi, testLiquidityProtectionDataStoreAddress);

            info('Deploying TestLiquidityProtection');

            rawData = fs.readFileSync(path.join(systemContractsDir, 'TestLiquidityProtection.json'));
            ({ abi, bytecode } = JSON.parse(rawData));

            const TestLiquidityProtection = new Contract(abi);
            arguments = [testLiquidityProtectionDataStoreAddress, testStakingRewardsAddress];

            instance = await web3Provider.send(TestLiquidityProtection.deploy({ data: bytecode, arguments }));
            const { address: testLiquidityProtectionAddress } = instance.options;

            info('Deployed new TestLiquidityProtection to', arg('address', testLiquidityProtectionAddress));

            contracts.TestLiquidityProtection = new Contract(abi, testLiquidityProtectionAddress);

            info('Registering TestLiquidityProtection in ContractRegistry');

            const {
                CheckpointStore: { owner: contractRegistryOwner }
            } = externalContracts;

            await web3Provider.send(
                contracts.ContractRegistry.methods.registerAddress(
                    LIQUIDITY_PROTECTION,
                    testLiquidityProtectionAddress
                ),
                { from: contractRegistryOwner }
            );

            info('Granting required permissions');

            info('Granting StakingRewardsStore ownership role ownership StakingRewards');

            await web3Provider.send(
                contracts.StakingRewardsStore.methods.grantRole(ROLE_OWNER, testStakingRewardsAddress)
            );

            info('Granting to the deployer the owner role on StakingRewardsStore');

            await web3Provider.send(
                contracts.StakingRewardsStore.methods.grantRole(ROLE_OWNER, web3Provider.getDefaultAccount())
            );

            info('Granting to the deployer the seeder role on StakingRewardsStore');

            await web3Provider.send(
                contracts.StakingRewardsStore.methods.grantRole(ROLE_SEEDER, web3Provider.getDefaultAccount())
            );

            info('Granting to StakingRewards the minter role on TokenGovernance');

            const {
                TokenGovernance: { governor }
            } = externalContracts;

            await web3Provider.send(
                contracts.TokenGovernance.methods.grantRole(ROLE_MINTER, testStakingRewardsAddress),
                {
                    from: governor
                }
            );

            info('Granting to the deployer the seeder role on CheckpointStore');

            const {
                CheckpointStore: { owner: checkpointStoreOwner }
            } = externalContracts;

            await web3Provider.send(
                contracts.CheckpointStore.methods.grantRole(ROLE_SEEDER, web3Provider.getDefaultAccount()),
                {
                    from: checkpointStoreOwner
                }
            );

            info('Granting to TestLiquidityProtection the publisher on TestStakingRewards');

            await web3Provider.send(
                contracts.TestStakingRewards.methods.grantRole(ROLE_PUBLISHER, testLiquidityProtectionAddress)
            );
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
