const setup = require('../utils/web3');
const { info, trace, error, arg } = require('../utils/logger');

const main = async () => {
    const { contracts, BN } = await setup();

    try {
        const dbDir = path.resolve(__dirname, '../data');
        const positionsDbPath = path.join(dbDir, 'positions.json');
        if (!fs.existsSync(positionsDbPath)) {
            error('Unable to locate', arg('db', positionsDbPath));
        }

        const positionsData = JSON.parse(fs.readFileSync(positionsDbPath));

        let lastAddedPosition;
        if (!positionsData.lastAddedPosition) {
            warning('DB last added position ID is missing. Starting from the beginning');
            lastAddedPosition = 0;
        } else {
            lastAddedPosition = positionsData.lastAddedPosition;
        }

        const { positions } = positionsData;
        const groupedPositions = Object.entries(positions).reduce((res, [id, data]) => {
            if (new BN(id).lte(new BN(lastAddedPosition))) {
                return res;
            }

            const { poolToken } = data;
            (res[poolToken] = res[poolToken] || []).push({ [id]: data });
            return res;
        }, {});

        const batchSize = 200;
        const lastId = lastAddedPosition;

        for (const [poolToken, positions] of groupedPositions) {
            const currentLastId = positions[positions.length - 1].id;

            info(
                'Adding positions',
                arg('poolToken', poolToken),
                arg('from', positions[0].id),
                arg('to', currentLastId),
                'in batches of',
                arg('batchSize', batchSize)
            );

            for (let i = 0; i < positions.length; i += batchSize) {
                const tempPositions = positions.slice(i, i + batchSize);
                for (const position of tempPositions) {
                    const { id, provider, startTime } = position;
                    trace('Adding position', arg('id', id), arg('provider', provider), arg('startTime', startTime));
                }

                const providers = [];
                const ids = [];
                const startTimes = [];
                for (const position of tempPositions) {
                    const { id, provider, startTime } = position;

                    ids.push(id);
                    providers.push(provider);
                    startTimes.push(startTime);
                }

                await contracts.StakingRewardsDistributionStore.methods
                    .addPositions(poolToken, data.providers, data.ids, data.startTimes)
                    .send();
            }

            if (new BN(lastId).lt(new BN(currentLastId))) {
                lastId = currentLastId;
            }
        }

        info('Verifying positions');

        for (const [poolToken, positions] of groupedPositions) {
            info('Verifying positions for', arg('poolToken', poolToken));

            for (const position of positions) {
                const { id, provider, startTime } = position;

                const data = await contracts.StakingRewardsDistributionStore.methods.position(id).call();

                if (data[0] !== provider) {
                    error("Position providers don't match", arg('expected', provider), arg('actual', data[0]));
                }

                if (data[1] !== poolToken) {
                    error("Position pool tokens don't match", arg('expected', provider), arg('actual', data[1]));
                }

                if (!new BN(data[2]).eq(startTime)) {
                    error("Position start times don't match", arg('expected', startTime), arg('actual', data[2]));
                }
            }
        }

        positionsData.lastAddedPosition = lastId;

        fs.writeFileSync(positionsDbPath, JSON.stringify(positionsData, null, 2));

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
