const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const setup = require('../utils/web3');
const { trace, info, error, warning, arg } = require('../utils/logger');

const REORG_OFFSET = 500;

const main = async () => {
    const { settings, web3, contracts, BN } = await setup();

    const getPositionChanges = async (multiplierResets, fromBlock, toBlock) => {
        const batchSize = 5000;
        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += batchSize) {
            const endBlock = Math.min(i + batchSize - 1, toBlock);

            info(
                'Querying all protection removal events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', batchSize),
                'blocks'
            );

            const events = await contracts.StakingRewardsDistribution.getPastEvents('allEvents', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp } = block;

                switch (event.event) {
                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;

                        trace(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        multiplierResets[provider] = BN.max(multiplierResets[provider] || new BN(0), new BN(timestamp));

                        eventCount++;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        multiplierResets[provider] = BN.max(multiplierResets[provider] || new BN(0), new BN(timestamp));

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new position remove events', arg('count', eventCount));
    };

    const getClaimedRewards = async (multiplierResets, fromBlock, toBlock) => {
        const batchSize = 5000;
        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += batchSize) {
            const endBlock = Math.min(i + batchSize - 1, toBlock);

            info(
                'Querying from reward claim events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', batchSize),
                'blocks'
            );

            const events = await contracts.StakingRewardsDistribution.getPastEvents('RewardsClaimed', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp } = block;

                const provider = returnValues._provider;
                const ids = returnValues._ids;

                trace(
                    'Found RewardsClaimed event at block',
                    arg('blockNumber', blockNumber),
                    arg('provider', provider),
                    arg(
                        'ids',
                        ids.map((id) => id.toString())
                    ),
                    arg('timestamp', timestamp),
                    arg('tx', transactionHash)
                );

                multiplierResets[provider] = BN.max(multiplierResets[provider] || new BN(0), new BN(timestamp));

                eventCount++;

                break;
            }
        }

        info('Finished processing all new reward claim events events', arg('count', eventCount));
    };

    const verifyMultiplierResets = async (multiplierResets, toBlock) => {
        info('Verifying all multiplier resets at', arg('blockNumber', toBlock));

        for (const [provider, timestamp] of Object.entries(multiplierResets)) {
            trace('Verifying multiplier resets for', arg('provider', provider));

            const lastRemoveTime = contracts.CheckpointStore.checkpoint(provider).call();
            const lastClaimTime = contracts.StakingRewardsDistributionStore.lastClaimTime(provider).call();
            const actualTime = BN.max(new BN(lastRemoveTime), new BN(lastClaimTime));

            if (!new BN(timestamp).eq(expectedTime)) {
                error(
                    'Wrong multiplier reset time for',
                    arg('provider', provider),
                    '[',
                    arg('expected', timestamp),
                    arg('actual', actualTime),
                    ']'
                );
            }
        }
    };

    const getMultiplierResets = async (data, fromBlock, toBlock) => {
        if (!data.multiplierResets) {
            data.multiplierResets = {};
        }

        await getPositionChanges(data.multiplierResets, fromBlock, toBlock);
        await getClaimedRewards(data.multiplierResets, fromBlock, toBlock);

        await verifyMultiplierResets(data.multiplierResets, toBlock);

        data.lastBlockNumber = toBlock;
    };

    try {
        const dbDir = path.resolve(__dirname, '../data');
        await mkdirp(dbDir);
        const dbPath = path.join(dbDir, 'multiplier-resets.json');
        let data = {};
        if (fs.existsSync(dbPath)) {
            const rawData = fs.readFileSync(dbPath);
            data = JSON.parse(rawData);
        }

        let fromBlock;
        if (!data.lastBlockNumber) {
            warning('DB last block number is missing. Starting from the beginning');
            fromBlock = settings.genesisBlock;
        } else {
            fromBlock = data.lastBlockNumber + 1;
        }

        const latestBlock = await web3.eth.getBlockNumber();
        if (latestBlock === 0) {
            error('Node is out of sync. Please try again later');
        }

        const toBlock = latestBlock - REORG_OFFSET;
        if (toBlock - fromBlock < REORG_OFFSET) {
            error(
                'Unable to satisfy the reorg window. Please wait for additional',
                arg('blocks', REORG_OFFSET - (toBlock - fromBlock + 1)),
                'to pass'
            );
        }

        info('Getting multiplier resets', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

        await getMultiplierResets(data, fromBlock, toBlock);

        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
