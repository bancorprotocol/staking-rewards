const path = require('path');
const fs = require('fs');

const Contract = require('web3-eth-contract');
const { keccak256 } = require('web3-utils');

const { info, error, warning, arg } = require('./logger');
const Provider = require('./provider');
const { test, init, reorgOffset } = require('./yargs');

const settings = require('../settings.json');

const ROLE_OWNER = keccak256('ROLE_OWNER');
const ROLE_MINTER = keccak256('ROLE_MINTER');
const ROLE_SEEDER = keccak256('ROLE_SEEDER');

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
    };

    const setupSystemContracts = async () => {
        const { externalContracts, systemContracts } = settings;

        if (init) {
            info('Deploying StakingRewardsStore');

            const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

            let rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsStore.json'));
            let { abi, bytecode } = JSON.parse(rawData);

            const StakingRewardsStore = new Contract(abi);
            let instance = await web3Provider.send(StakingRewardsStore.deploy({ data: bytecode }));

            const { address: stakingStoreAddress } = instance.options;

            info('Deployed new StakingRewardsStore to', arg('address', stakingStoreAddress));

            contracts.StakingRewardsStore = new Contract(abi, stakingStoreAddress);

            info('Deploying StakingRewards');

            rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewards.json'));
            ({ abi, bytecode } = JSON.parse(rawData));

            const StakingRewards = new Contract(abi);
            const arguments = [
                stakingStoreAddress,
                contracts.TokenGovernance.options.address,
                contracts.CheckpointStore.options.address,
                externalContracts.ContractRegistry.address
            ];

            instance = await web3Provider.send(StakingRewards.deploy({ data: bytecode, arguments }));
            const { address: stakingAddress } = instance.options;

            info('Deployed new StakingRewards to', arg('address', stakingAddress));

            contracts.StakingRewards = new Contract(abi, stakingAddress);

            info('Granting required permissions');

            info('Granting StakingRewardsStore ownership to StakingRewards');

            await web3Provider.send(contracts.StakingRewardsStore.methods.grantRole(ROLE_OWNER, stakingAddress));

            info('Granting TokenGovernance minting permissions to StakingRewards');

            const {
                TokenGovernance: { governor }
            } = externalContracts;

            await web3Provider.send(contracts.TokenGovernance.methods.grantRole(ROLE_MINTER, stakingAddress), {
                from: governor
            });

            info('Granting CheckpointStore seeding permissions to the deployer');

            const {
                CheckpointStore: { owner }
            } = externalContracts;

            await web3Provider.send(
                contracts.CheckpointStore.methods.grantRole(ROLE_SEEDER, web3Provider.getDefaultAccount()),
                {
                    from: owner
                }
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
            web3Provider,
            contracts,
            Contract,
            reorgOffset,
            test
        };
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

module.exports = setup;
