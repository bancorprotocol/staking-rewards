const fs = require('fs');
const path = require('path');
const { info, warning, trace, error, arg } = require('../utils/logger');

const BATCH_SIZE = 500;

const setPositionsTask = async (env) => {
    const { contracts, BN, defaultAccount } = env;

    const groupPositions = (positions) => {
        return Object.entries(positions).reduce((res, [id, data]) => {
            const { poolToken } = data;
            (res[poolToken] = res[poolToken] || []).push({ id, ...data });
            return res;
        }, {});
    };

    const setPositions = async (positions) => {
        info('Adding positions');

        const groupedPositions = groupPositions(positions);

        for (const [poolToken, poolTokenPositions] of Object.entries(groupedPositions)) {
            const participating = await contracts.StakingRewardsDistributionStore.methods
                .isPoolParticipating(poolToken)
                .call();
            if (!participating) {
                warning('Skipping non-participating pool', arg('poolToken', poolToken));

                continue;
            }

            info('Adding positions for', arg('poolToken', poolToken), 'in batches of', arg('batchSize', BATCH_SIZE));

            for (let i = 0; i < poolTokenPositions.length; i += BATCH_SIZE) {
                const tempPositions = poolTokenPositions.slice(i, i + BATCH_SIZE);
                for (const position of tempPositions) {
                    const { id, provider, timestamp } = position;

                    trace('Adding position', arg('id', id), arg('provider', provider), arg('timestamp', timestamp));
                }

                const providers = [];
                const ids = [];
                const startTimes = [];
                for (const position of tempPositions) {
                    const { id, provider, timestamp } = position;

                    const exists = await contracts.StakingRewardsDistributionStore.methods.positionExists(id).call();
                    if (exists) {
                        trace('Skipping existing position', arg('id', id));

                        continue;
                    }

                    ids.push(id);
                    providers.push(provider);
                    startTimes.push(timestamp);
                }

                const gas = await contracts.StakingRewardsDistributionStore.methods
                    .addPositions(poolToken, providers, ids, startTimes)
                    .estimateGas({ from: defaultAccount });
                await contracts.StakingRewardsDistributionStore.methods
                    .addPositions(poolToken, providers, ids, startTimes)
                    .send({ from: defaultAccount, gas });
            }
        }
    };

    const verifyPositions = async (positions) => {
        info('Verifying positions');

        const groupedPositions = groupPositions(positions);

        for (const [poolToken, poolTokenPositions] of Object.entries(groupedPositions)) {
            const participating = await contracts.StakingRewardsDistributionStore.methods
                .isPoolParticipating(poolToken)
                .call();
            if (!participating) {
                warning('Skipping verification for non non-participating pool', arg('poolToken', poolToken));

                continue;
            }

            info('Verifying positions for', arg('poolToken', poolToken));

            for (const position of poolTokenPositions) {
                const { id, provider, startTime } = position;

                const data = await contracts.StakingRewardsDistributionStore.methods.position(id).call();

                if (data[0] !== provider) {
                    error("Position providers don't match", arg('expected', provider), arg('actual', data[0]));
                }

                if (data[1] !== poolToken) {
                    error("Position pool tokens don't match", arg('expected', provider), arg('actual', data[1]));
                }

                if (data[2] != startTime) {
                    error("Position start times don't match", arg('expected', startTime), arg('actual', data[2]));
                }
            }
        }
    };

    const dbDir = path.resolve(__dirname, '../data');
    const positionsDbPath = path.join(dbDir, 'positions.json');
    if (!fs.existsSync(positionsDbPath)) {
        error('Unable to locate', arg('db', positionsDbPath));
    }

    const { positions } = JSON.parse(fs.readFileSync(positionsDbPath));

    await setPositions(positions);
    await verifyPositions(positions);
};

module.exports = setPositionsTask;
