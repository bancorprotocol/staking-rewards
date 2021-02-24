const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const setup = require('./utils/web3');
const { info, error, setVerbose, setMultiline } = require('./utils/logger');

const getLiquidityTask = require('./tasks/get-liquidity');

const main = async () => {
    try {
        let env;

        await yargs(hideBin(process.argv))
            .option('verbose', {
                alias: 'v',
                type: 'boolean',
                description: 'Run with verbose logging'
            })
            .option('multiline', {
                alias: 'm',
                type: 'boolean',
                description: 'Format log arguments in multiple lines'
            })
            .option('test', {
                alias: 't',
                type: 'boolean',
                description: 'Run in test mode'
            })
            .option('init', {
                alias: 'i',
                type: 'boolean',
                description: 'Deploy new contracts for testing (test mode only)'
            })
            .option('reorg-offset', {
                alias: 'r',
                type: 'number',
                default: 500,
                description: 'Reorg blocks offset to take into account'
            })
            .option('gas-price', {
                alias: 'g',
                type: 'number',
                description: 'The gas price in wei to use for setting transactions (in gwei)'
            })
            .middleware(({ verbose, multiline }) => {
                setVerbose(verbose);
                setMultiline(multiline);
            })
            .middleware(async (argv) => {
                env = await setup(argv);
            })
            .command(
                'reset',
                'Resets the DB',
                () => {},
                async () => {
                    const dbDir = path.resolve(__dirname, './data');

                    if (reset) {
                        info('Resetting the local DB');

                        fs.rmdirSync(dbDir, { recursive: true });
                    }
                    await mkdirp(dbDir);
                }
            )
            .command(
                'get-liquidity',
                'Get all liquidity changes',
                () => {},
                async () => getLiquidityTask(env)
            )
            .demandCommand()
            .help()
            .parse();
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
