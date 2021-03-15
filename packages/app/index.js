const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const setup = require('./utils/web3');
const { info, error, setVerbose, setMultiline } = require('./utils/logger');

const getLiquidityTask = require('./tasks/get-liquidity');
const getPoolPendingRewardsTask = require('./tasks/get-pool-pending-rewards');
const setProgramsTask = require('./tasks/set-programs');
const storePoolRewardsTask = require('./tasks/store-pool-rewards');

const main = async () => {
    try {
        let env;
        const dbDir = path.resolve(__dirname, './data');
        await mkdirp(dbDir);

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
                    info('Resetting the local DB');

                    fs.rmdirSync(dbDir, { recursive: true });
                    await mkdirp(dbDir);
                }
            )
            .command(
                'get-liquidity',
                'Get all liquidity changes',
                () => {},
                async () => getLiquidityTask(env)
            )
            .command(
                'get-pool-pending-rewards',
                'Get pool pending rewards',
                (yargs) => {
                    return yargs.option('pool-token', {
                        alias: 'p',
                        description: 'The address of the pool token',
                        type: 'string'
                    });
                },
                async ({ poolToken }) => getPoolPendingRewardsTask(env, { poolToken })
            )
            .command(
                'set-programs',
                'Set reward programs',
                (yargs) => {
                    return yargs.option('programs-path', {
                        alias: 'p',
                        description: 'The path to the programs.json config file',
                        type: 'string'
                    });
                },
                async ({ programsPath }) => setProgramsTask(env, { programsPath })
            )
            .command(
                'store-pool-rewards',
                'Store pool rewards',
                (yargs) => {
                    return yargs.option('pool-token', {
                        alias: 'p',
                        description: 'The address of the pool token',
                        type: 'string'
                    });
                },
                async ({ poolToken }) => storePoolRewardsTask(env, { poolToken })
            )
            .onFinishCommand(() => {
                process.exit(0);
            })
            .demandCommand()
            .help()
            .parse();
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
