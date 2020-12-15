const path = require('path');
const fs = require('fs');
const ganache = require('ganache-core');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');
const memdown = require('memdown');

const { info, error, warning, arg } = require('./logger');

const { test, init, reorgOffset } = require('./yargs');

const settings = require('../settings.json');

let web3;
let contracts = {};
let defaultAccount;

const setup = async () => {
    const { externalContracts, systemContracts, web3Provider } = settings;
    const { TokenGovernance: TokenGovernanceSettings } = externalContracts;

    try {
        if (!test) {
            info('Running against mainnet');

            web3 = new Web3(web3Provider);

            const { privateKey } = require('../credentials.json');
            const account = web3.eth.accounts.privateKeyToAccount(privateKey);
            web3.eth.accounts.wallet.add(account);

            defaultAccount = account.address;

            web3.eth.defaultAccount = defaultAccount;

            Contract.setProvider(web3Provider);
            Contract.defaultAccount = defaultAccount;
        } else {
            info('Running against a mainnet fork (via Ganache)');

            const provider = ganache.provider({
                fork: web3Provider,
                ws: true,
                network_id: 1,
                db: memdown(),
                default_balance_ether: 10000000000000000000,
                unlocked_accounts: [TokenGovernanceSettings.governor]
            });

            info('Started forking the mainnet');

            web3 = new Web3(provider);

            defaultAccount = (await web3.eth.getAccounts())[0];

            info('Finished forking the mainnet');

            web3.eth.defaultAccount = defaultAccount;

            Contract.setProvider(provider);
            Contract.defaultAccount = defaultAccount;
        }

        const { BN, keccak256 } = web3.utils;

        let { abi, address } = externalContracts.LiquidityProtectionStore;
        contracts.LiquidityProtectionStore = new Contract(abi, address);

        if (init) {
            info('Deploying new system contracts');

            const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

            info('Deploying StakingRewardsDistributionStore');

            let rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsDistributionStore.json'));
            let { abi, bytecode } = JSON.parse(rawData);

            const StakingRewardsDistributionStore = new Contract(abi);
            let gas = await StakingRewardsDistributionStore.deploy({ data: bytecode }).estimateGas();
            let instance = await StakingRewardsDistributionStore.deploy({ data: bytecode }).send({
                from: defaultAccount,
                gas
            });

            const { address: stakingStoreAddress } = instance.options;

            info('Deployed new StakingRewardsDistributionStore to', arg('address', stakingStoreAddress));

            contracts.StakingRewardsDistributionStore = new Contract(abi, stakingStoreAddress);

            info('Deploying StakingRewardsDistribution');

            const {
                rewards: { maxRewards }
            } = settings;

            rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsDistribution.json'));
            ({ abi, bytecode } = JSON.parse(rawData));

            const StakingRewardsDistribution = new Contract(abi);
            const arguments = [
                stakingStoreAddress,
                TokenGovernanceSettings.address,
                externalContracts.CheckpointStore.address,
                maxRewards,
                externalContracts.ContractRegistry.address
            ];

            gas = await StakingRewardsDistribution.deploy({ data: bytecode, arguments }).estimateGas();
            instance = await StakingRewardsDistribution.deploy({ data: bytecode, arguments }).send({
                from: defaultAccount,
                gas
            });

            const { address: stakingAddress } = instance.options;

            info('Deployed new StakingRewardsDistribution to', arg('address', stakingAddress));

            contracts.StakingRewardsDistribution = new Contract(abi, stakingAddress);

            info('Granting required permissions');

            const ROLE_OWNER = keccak256('ROLE_OWNER');
            const ROLE_MINTER = keccak256('ROLE_MINTER');

            info('Granting StakingRewardsDistributionStore ownership to StakingRewardsDistribution');

            gas = await contracts.StakingRewardsDistributionStore.methods
                .grantRole(ROLE_OWNER, stakingAddress)
                .estimateGas({ from: defaultAccount });
            await contracts.StakingRewardsDistributionStore.methods
                .grantRole(ROLE_OWNER, stakingAddress)
                .send({ from: defaultAccount, gas });

            ({ abi, address } = externalContracts.TokenGovernance);
            contracts.TokenGovernance = new Contract(abi, address);

            info('Granting TokenGovernance minting permissions to StakingRewardsDistribution');

            gas = await contracts.TokenGovernance.methods
                .grantRole(ROLE_MINTER, stakingAddress)
                .estimateGas({ from: TokenGovernanceSettings.governor });
            await contracts.TokenGovernance.methods
                .grantRole(ROLE_MINTER, stakingAddress)
                .send({ from: TokenGovernanceSettings.governor, gas });
        } else {
            let { abi, address } = systemContracts.StakingRewardsDistributionStore;
            if (abi && address) {
                contracts.StakingRewardsDistributionStore = new Contract(abi, address);
            } else {
                warning('Unable to retrieve StakingRewardsDistributionStore settings');
            }

            ({ abi, address } = systemContracts.StakingRewardsDistribution);
            if (abi && address) {
                contracts.StakingRewardsDistribution = new Contract(abi, address);
            } else {
                warning('Unable to retrieve StakingRewardsDistribution settings');
            }
        }

        return { settings, web3, contracts, defaultAccount, BN, Contract, reorgOffset };
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

module.exports = setup;
