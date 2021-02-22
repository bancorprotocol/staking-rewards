const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const setup = require('./utils/web3');
const { info, error } = require('./utils/logger');

const argv = require('./utils/yargs');

const getLiquidityTask = require('./tasks/get-liquidity');

const main = async () => {
    try {
        // Set up local DB.
        const dbDir = path.resolve(__dirname, './data');

        const { reset } = argv;
        if (reset) {
            info('Resetting the local DB');

            fs.rmdirSync(dbDir, { recursive: true });
        }
        await mkdirp(dbDir);

        // Set up the local web3 environment.
        const env = await setup();

        // Handle all the tasks in the right order.
        const { getLiquidity } = argv;

        let programsSet = false;

        if (getLiquidity) {
            await getLiquidityTask(env);
        }

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
