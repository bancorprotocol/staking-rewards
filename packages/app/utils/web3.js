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

    const initExternalContract = (name) => {
        const { externalContracts } = settings;
        const externalContractsDir = path.resolve(
            __dirname,
            '../../../node_modules/@bancor/contracts/solidity/build/contracts'
        );

        const { address } = externalContracts[name];
        const rawData = fs.readFileSync(path.join(externalContractsDir, `${name}.json`));
        const { abi } = JSON.parse(rawData);
        contracts[name] = new Contract(abi, address);
    };

    const setupExternalContracts = async () => {
        info('Setting up External Contracts');

        initExternalContract('TokenGovernance');
        initExternalContract('CheckpointStore');
        initExternalContract('ContractRegistry');
        initExternalContract('LiquidityProtectionSettings');
        initExternalContract('LiquidityProtectionStore');
        initExternalContract('LiquidityProtectionStats');
        initExternalContract('LiquidityProtection');
    };

    const deploySystemContract = async (name, { arguments, contractName } = {}) => {
        const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

        info(`Deploying ${name}`);

        const rawData = fs.readFileSync(path.join(systemContractsDir, `${contractName || name}.json`));
        const { abi, bytecode } = JSON.parse(rawData);

        const contract = new Contract(abi);
        const instance = await web3Provider.send(contract.deploy({ data: bytecode, arguments: arguments || [] }));

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
            await deploySystemContract('TestStakingRewards', {
                arguments: [
                    contracts.StakingRewardsStore.options.address,
                    contracts.TokenGovernance.options.address,
                    contracts.TestCheckpointStore.options.address,
                    externalContracts.ContractRegistry.address
                ]
            });

            await deploySystemContract('TestLiquidityProtectionStats', { contractName: 'LiquidityProtectionStats' });
            await deploySystemContract('TestLiquidityProtectionSimulator', {
                arguments: [
                    contracts.TestStakingRewards.options.address,
                    contracts.LiquidityProtectionSettings.options.address,
                    contracts.LiquidityProtectionStore.options.address,
                    contracts.TestLiquidityProtectionStats.options.address,
                    contracts.TokenGovernance.options.address,
                    contracts.TokenGovernance.options.address,
                    contracts.TestCheckpointStore.options.address
                ]
            });

            info('Registering contracts');

            await registerContract(LIQUIDITY_PROTECTION, 'TestLiquidityProtectionSimulator');

            info('Granting required permissions');

            await grantRole('StakingRewardsStore', 'ROLE_OWNER', 'TestStakingRewards');
            await grantRole('StakingRewardsStore', 'ROLE_SEEDER', web3Provider.getDefaultAccount());
            await grantRole('TokenGovernance', 'ROLE_MINTER', 'TestStakingRewards', {
                from: externalContracts.TokenGovernance.governor
            });
            await grantRole('TestCheckpointStore', 'ROLE_SEEDER', web3Provider.getDefaultAccount());
            await grantRole('TestCheckpointStore', 'ROLE_OWNER', 'TestLiquidityProtectionSimulator');

            await grantRole('TestStakingRewards', 'ROLE_PUBLISHER', 'TestLiquidityProtectionSimulator');
            await grantRole('LiquidityProtectionSettings', 'ROLE_OWNER', 'TestLiquidityProtectionSimulator', {
                from: externalContracts.LiquidityProtectionSettings.owner
            });
            await grantRole('TestLiquidityProtectionStats', 'ROLE_OWNER', 'TestLiquidityProtectionSimulator');

            info('Transferring LiquidityProtectionStore ownership to TestLiquidityProtectionSimulator');
            await web3Provider.send(
                contracts.LiquidityProtection.methods.transferStoreOwnership(
                    contracts.TestLiquidityProtectionSimulator.options.address
                ),
                {
                    from: externalContracts.LiquidityProtection.owner
                }
            );
            await web3Provider.send(contracts.TestLiquidityProtectionSimulator.methods.acceptStoreOwnership());
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
