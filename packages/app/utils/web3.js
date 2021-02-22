const path = require('path');
const fs = require('fs');

const Contract = require('web3-eth-contract');
const { keccak256, asciiToHex } = require('web3-utils');

const { info, error, warning, arg } = require('./logger');
const Provider = require('./provider');
const { test, init, reorgOffset } = require('./yargs');

const settings = require('../settings.json');

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
            '../../../node_modules/@bancor/contracts-solidity/solidity/build/contracts'
        );

        const { address } = externalContracts[name];
        const rawData = fs.readFileSync(path.join(externalContractsDir, `${name}.json`));
        const { abi } = JSON.parse(rawData);
        contracts[name] = new Contract(abi, address);
    };

    const initSystemContract = (name) => {
        const { systemContracts } = settings;
        const systemContractsDir = path.resolve(__dirname, '../../solidity/build/contracts');

        const { address } = systemContracts[name];
        if (!address) {
            warning(`Unable to retrieve ${name} settings`);

            return;
        }

        const rawData = fs.readFileSync(path.join(systemContractsDir, `${name}.json`));
        const { abi } = JSON.parse(rawData);
        contracts[name] = new Contract(abi, address);
    };

    const setupExternalContracts = async () => {
        info('Setting up External Contracts');

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
        initSystemContract('StakingRewardsStore');
        initSystemContract('StakingRewards');
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
