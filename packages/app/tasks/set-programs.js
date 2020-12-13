const humanizeDuration = require('humanize-duration');

const setup = require('../utils/web3');
const { info, error, arg } = require('../utils/logger');

const main = async () => {
    const { settings, web3, contracts, BN } = await setup();

    const setPools = async (pools) => {
        info('Adding pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, weeklyRewards } = pool;

            info(
                'Adding pool program',
                arg('poolToken', poolToken),
                arg('startTime', startTime),
                arg('endTime', endTime),
                arg('duration', humanizeDuration((endTime - startTime) * 1000).toString()),
                arg('weeklyRewards', weeklyRewards)
            );

            await contracts.StakingRewardsDistributionStore.methods
                .addPoolProgram(poolToken, startTime, endTime, weeklyRewards)
                .send();
        }
    };

    const verifyPools = async (pools) => {
        info('Verifying pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, weeklyRewards } = pool;

            info('Verifying pool', arg('poolToken', poolToken));

            const data = await contracts.StakingRewardsDistributionStore.methods.poolProgram(poolToken).call();

            if (!new BN(data[0]).eq(startTime)) {
                error("Pool start times don't match", arg('expected', startTime), arg('actual', data[0]));
            }

            if (!new BN(data[1]).eq(endTime)) {
                error("Pool end times don't match", arg('expected', endTime), arg('actual', data[1]));
            }

            if (!new BN(data[2]).eq(weeklyRewards)) {
                error("Pool weekly rewards times don't match", arg('expected', weeklyRewards), arg('actual', data[2]));
            }
        }
    };

    try {
        // TODO: remove
        const block = await web3.eth.getBlock(11271014);
        console.log(block.timestamp);

        process.exit(0);

        const {
            rewards: { pools }
        } = settings;

        await setPools(pools);
        await verifyPools(pools);

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
