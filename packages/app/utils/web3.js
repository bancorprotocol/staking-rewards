const path = require('path');
const fs = require('fs');

const Contract = require('web3-eth-contract');
const { keccak256, asciiToHex } = require('web3-utils');

const { info, error, warning, arg } = require('./logger');
const Provider = require('./provider');

const settings = require('../settings.json');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

let contracts = {};
let web3Provider;

const setup = async ({ test, gasPrice, init, reorgOffset }) => {
    const setupProvider = async () => {
        web3Provider = new Provider();

        await web3Provider.initialize({ test: test || init, gasPrice });
    };

    const initExternalContract = async (name) => {
        const { externalContracts } = settings;
        const externalContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

        let { address } = externalContracts[name];
        if (!address) {
            // If the address isn't specified, try to fetch it from the registry.
            address = await addressOf(name);
        }

        const rawData = fs.readFileSync(path.join(externalContractsDir, `${name}.json`));
        const { abi } = JSON.parse(rawData);
        contracts[name] = new Contract(abi, address);
    };

    const initSystemContract = async (name, contractName) => {
        const { systemContracts } = settings;
        const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

        let { address } = systemContracts[contractName || name];
        if (!address) {
            // If the address isn't specified, try to fetch it from the registry.
            address = await addressOf(name);
        }

        const rawData = fs.readFileSync(path.join(systemContractsDir, `${name}.json`));
        const { abi } = JSON.parse(rawData);
        contracts[contractName || name] = new Contract(abi, address);
    };

    const setupExternalContracts = async () => {
        info('Setting up external contracts');

        await initExternalContract('TokenGovernance');
        await initExternalContract('CheckpointStore');
        await initExternalContract('ContractRegistry');
        await initExternalContract('LiquidityProtectionStore');
        await initExternalContract('LiquidityProtectionStats');
        await initExternalContract('LiquidityProtection');
        await initExternalContract('CheckpointStore');
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

    const addressOf = async (name) => {
        // If the address isn't specified, try to fetch it from the registry.
        const address = await web3Provider.call(contracts.ContractRegistry.methods.addressOf(asciiToHex(name)));
        if (address === ZERO_ADDRESS) {
            error(`Unable to retrieve the address of ${name}`);
        }

        return address;
    };

    const grantRole = async (contract, role, name, options = {}) => {
        info(`Granting ${name} the ${role} role on ${contract}`);

        const address = name.startsWith('0x') ? name : contracts[name].options.address;
        return web3Provider.send(contracts[contract].methods.grantRole(keccak256(role), address), options);
    };

    const setupSystemContracts = async () => {
        info('Setting up system contracts');

        await initSystemContract('StakingRewardsStore');

        if (init) {
            const { systemContracts, externalContracts } = settings;

            info('Deploying contracts');

            await deploySystemContract('StakingRewards', {
                arguments: [
                    contracts.StakingRewardsStore.options.address,
                    contracts.TokenGovernance.options.address,
                    contracts.CheckpointStore.options.address,
                    contracts.ContractRegistry.options.address
                ]
            });

            info('Granting required permissions');

            await grantRole('StakingRewardsStore', 'ROLE_OWNER', 'StakingRewards', {
                from: systemContracts.StakingRewardsStore.supervisor
            });

            await grantRole('StakingRewardsStore', 'ROLE_SEEDER', web3Provider.getDefaultAccount(), {
                from: systemContracts.StakingRewardsStore.supervisor
            });

            await grantRole('StakingRewardsStore', 'ROLE_MANAGER', web3Provider.getDefaultAccount(), {
                from: systemContracts.StakingRewardsStore.supervisor
            });

            await grantRole('StakingRewards', 'ROLE_UPDATER', web3Provider.getDefaultAccount());

            await grantRole('TokenGovernance', 'ROLE_MINTER', 'StakingRewards', {
                from: externalContracts.TokenGovernance.governor
            });

            await grantRole('StakingRewards', 'ROLE_PUBLISHER', 'LiquidityProtection');
        } else {
            await initSystemContract('StakingRewards');
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
