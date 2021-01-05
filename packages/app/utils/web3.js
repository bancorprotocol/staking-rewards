const path = require('path');
const fs = require('fs');
const ganache = require('ganache-core');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');
const { keccak256, toWei } = require('web3-utils');
const memdown = require('memdown');

const { info, error, warning, arg } = require('./logger');

const { test, init, reorgOffset, gasPrice } = require('./yargs');

const settings = require('../settings.json');

const ROLE_OWNER = keccak256('ROLE_OWNER');
const ROLE_MINTER = keccak256('ROLE_MINTER');
const ROLE_SEEDER = keccak256('ROLE_SEEDER');

let web3;
let contracts = {};
let defaultAccount;

const setup = async () => {
    const setupEnv = async () => {
        const { web3Provider } = settings;

        const { privateKey } = require('../credentials.json');

        if (!test) {
            info('Running against mainnet');

            web3 = new Web3(web3Provider);
            Contract.setProvider(web3Provider);
        } else {
            info('Running against a mainnet fork (via Ganache)');

            const { externalContracts } = settings;

            const provider = ganache.provider({
                fork: web3Provider,
                accounts: [{ secretKey: privateKey, balance: 10000000000000000000 }],
                ws: true,
                network_id: 1,
                db: memdown(),
                default_balance_ether: 10000000000000000000,
                unlocked_accounts: [externalContracts.TokenGovernance.governor]
            });

            info('Started forking the mainnet');

            web3 = new Web3(provider);

            info('Finished forking the mainnet');

            Contract.setProvider(provider);
        }

        const account = web3.eth.accounts.privateKeyToAccount(privateKey);
        web3.eth.accounts.wallet.add(account);

        defaultAccount = account.address;
        web3.eth.defaultAccount = defaultAccount;
        Contract.defaultAccount = defaultAccount;
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
            let gas = await StakingRewardsStore.deploy({ data: bytecode }).estimateGas();
            let instance = await StakingRewardsStore.deploy({ data: bytecode }).send({
                from: defaultAccount,
                gas
            });

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

            gas = await StakingRewards.deploy({ data: bytecode, arguments }).estimateGas();
            instance = await StakingRewards.deploy({ data: bytecode, arguments }).send({
                from: defaultAccount,
                gas
            });

            const { address: stakingAddress } = instance.options;

            info('Deployed new StakingRewards to', arg('address', stakingAddress));

            contracts.StakingRewards = new Contract(abi, stakingAddress);

            info('Granting required permissions');

            info('Granting StakingRewardsStore ownership to StakingRewards');

            gas = await contracts.StakingRewardsStore.methods
                .grantRole(ROLE_OWNER, stakingAddress)
                .estimateGas({ from: defaultAccount });
            await contracts.StakingRewardsStore.methods
                .grantRole(ROLE_OWNER, stakingAddress)
                .send({ from: defaultAccount, gas });

            info('Granting TokenGovernance minting permissions to StakingRewards');

            const {
                TokenGovernance: { governor }
            } = externalContracts;
            gas = await contracts.TokenGovernance.methods
                .grantRole(ROLE_MINTER, stakingAddress)
                .estimateGas({ from: governor });
            await contracts.TokenGovernance.methods
                .grantRole(ROLE_MINTER, stakingAddress)
                .send({ from: governor, gas });

            info('Granting CheckpointStore seeding permissions to the deployer');

            const {
                CheckpointStore: { owner }
            } = externalContracts;

            gas = await contracts.CheckpointStore.methods
                .grantRole(ROLE_SEEDER, defaultAccount)
                .estimateGas({ from: owner });
            await contracts.CheckpointStore.methods.grantRole(ROLE_SEEDER, defaultAccount).send({ from: owner, gas });
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
        await setupEnv();
        await setupExternalContracts();
        await setupSystemContracts();

        return {
            settings,
            web3,
            contracts,
            defaultAccount,
            Contract,
            reorgOffset,
            gasPrice: toWei((gasPrice || 0).toString(), 'gwei'),
            test
        };
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

module.exports = setup;
