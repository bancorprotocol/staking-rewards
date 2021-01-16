const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const setup = require('./utils/web3');
const { info, warning, error } = require('./utils/logger');

const argv = require('./utils/yargs');

const getLiquidityTask = require('./tasks/get-liquidity');
const getLastRemovalTimesTask = require('./tasks/get-last-removal-times');
const getRewardsTask = require('./tasks/get-rewards');

const setLastRemovalTimesTask = require('./tasks/set-last-removal-times');
const setProgramsTask = require('./tasks/set-programs');
const setRewardsTask = require('./tasks/set-rewards');

const GET_REWARDS_DELAY = 30000;

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
        const { getLiquidity, getLastRemovalTimes, getRewards, setLastRemovalTimes, setPrograms, setRewards } = argv;

        let programsSet = false;

        if (getLiquidity) {
            await getLiquidityTask(env);
        }

        if (getLastRemovalTimes) {
            await getLastRemovalTimesTask(env);
        }

        if (getRewards) {
            await setProgramsTask(env);
            programsSet = true;

            info('Bootstrapping rewards');

            await getRewardsTask(env);

            while (true) {
                info(`Waiting for ${GET_REWARDS_DELAY / 1000} seconds`);
                await new Promise((r) => setTimeout(r, GET_REWARDS_DELAY));

                await getRewardsTask(env, { resume: true });
            }
        }

        if (setLastRemovalTimes) {
            await setLastRemovalTimesTask(env);
        }

        if (!programsSet && setPrograms) {
            await setProgramsTask(env);
        }

        if (setRewards) {
            await setRewardsTask(env);
        }

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
