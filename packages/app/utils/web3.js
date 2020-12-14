const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const path = require('path');
const fs = require('fs');
const ganache = require('ganache-core');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');

const { info, warning, arg } = require('./logger');

const { argv } = yargs(hideBin(process.argv))
    .option('test', {
        type: 'boolean',
        description: 'Run in test mode'
    })
    .option('init', {
        type: 'boolean',
        description: 'Deploy new contracts for testing (during test mode only)'
    });

const { test, init } = argv;

const settings = require('../settings.json');
const { web3Provider } = settings;

let web3;
let contracts = {};

const setup = async () => {
    const { externalContracts } = settings;
    const { TokenGovernance: TokenGovernanceSettings } = externalContracts;

    if (!test) {
        info('Running against mainnet');

        web3 = new Web3(settings.web3Provider);

        const { privateKey } = require('../credentials.json');
        const account = web3.eth.accounts.privateKeyToAccount(privateKey);
        web3.eth.accounts.wallet.add(account);
        web3.eth.defaultAccount = account.address;

        Contract.setProvider(settings.web3Provider);
    } else {
        info('Running against a mainnet fork (via Ganache)');

        const defaultAccount = '0x0000000000000000000000000000000000000001';
        const provider = ganache.provider({
            default_balance_ether: 10000000000000000000,
            fork: web3Provider,
            unlocked_accounts: [defaultAccount, TokenGovernanceSettings.governor]
        });

        web3 = new Web3(provider);
        web3.eth.defaultAccount = defaultAccount;
        Contract.setProvider(provider);
    }

    const { BN, keccak256 } = web3.utils;

    const { abi, address } = externalContracts.LiquidityProtectionStore;
    contracts.LiquidityProtectionStore = new Contract(abi, address);

    if (init) {
        info('Deploying new system contracts');

        const systemContractsDir = path.resolve(__dirname, '../../solidity/build');

        info('Deploying StakingRewardsDistributionStore');

        let rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsDistributionStore.json'));
        let { abi, bytecode } = JSON.parse(rawData);

        const StakingRewardsDistributionStore = new Contract(abi);
        let instance = await StakingRewardsDistributionStore.deploy({ data: bytecode }).send();

        let { address } = instance.options;

        info('Deployed new StakingRewardsDistributionStore to', arg('address', address));

        contracts.StakingRewardsDistributionStore = new Contract(abi, address);

        info('Deploying StakingRewardsDistribution');

        rawData = fs.readFileSync(path.join(systemContractsDir, 'StakingRewardsDistribution.json'));
        ({ abi, bytecode } = JSON.parse(rawData));

        const StakingRewardsDistribution = new Contract(abi);
        instance = await StakingRewardsDistribution.deploy({
            data: bytecode,
            arguments: [
                contracts.StakingRewardsDistributionStore.address,
                TokenGovernanceSettings.address,
                externalContracts.CheckpointStore.address,
                new BN(2).pow(new BN(256)).sub(new BN(1)),
                externalContracts.ContractRegistry.address
            ]
        }).send();

        ({ address } = instance.options);

        info('Deployed new StakingRewardsDistribution to', arg('address', address));

        contracts.StakingRewardsDistribution = new Contract(abi, address);

        info('Granting requires permissions to StakingRewardsDistribution');

        const ROLE_OWNER = keccak256('ROLE_OWNER');
        const ROLE_MINTER = keccak256('ROLE_MINTER');

        await contracts.StakingRewardsDistributionStore.methods.grantRole(ROLE_OWNER, address).send();

        await contracts.TokenGovernance.methods
            .grantRole(ROLE_MINTER, address)
            .send({ from: TokenGovernanceSettings.governor });
    } else {
        const { systemContracts } = settings;

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

    return { settings, web3, contracts, BN, Contract };
};

module.exports = setup;
