const fs = require('fs');
const path = require('path');

const { trace, info, error, warning, arg } = require('../utils/logger');

const BATCH_SIZE = 5000;

const getMultiplierResetsTask = async (env) => {
    const addSnapshot = (snapshots, timestamp, blockNumber) => {
        const snapshot = {
            timestamp,
            blockNumber
        };
        const existing = snapshots.findIndex((i) => i.timestamp == timestamp && i.blockNumber == blockNumber);
        if (existing !== -1) {
            snapshots[existing] = snapshot;
        } else {
            snapshots.push(snapshot);
        }
    };

    const getPositionChanges = async (multiplierResets, fromBlock, toBlock) => {
        const BATCH_SIZE = 5000;
        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection removal events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
                'blocks'
            );

            const events = await contracts.LiquidityProtectionStore.getPastEvents('allEvents', {
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

                        if (!multiplierResets[provider]) {
                            multiplierResets[provider] = { snapshots: [] };
                        }

                        addSnapshot(multiplierResets[provider].snapshots, timestamp, blockNumber);

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

                        if (!multiplierResets[provider]) {
                            multiplierResets[provider] = { snapshots: [] };
                        }

                        addSnapshot(multiplierResets[provider].snapshots, timestamp, blockNumber);

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new position remove events', arg('count', eventCount));
    };

    const getClaimedRewards = async (multiplierResets, fromBlock, toBlock) => {
        if (!contracts.StakingRewardsDistribution) {
            warning('Unable to query reward claim events. StakingRewardsDistribution is missing');

            return;
        }

        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying reward claim events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
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

                if (!multiplierResets[provider]) {
                    multiplierResets[provider] = { snapshots: [] };
                }

                addSnapshot(multiplierResets[provider].snapshots, timestamp, blockNumber);

                eventCount++;

                break;
            }
        }

        info('Finished processing all new reward claim events events', arg('count', eventCount));
    };

    const verifyMultiplierResets = async (multiplierResets, toBlock) => {
        info('Verifying all multiplier resets at', arg('blockNumber', toBlock));

        for (const [provider, data] of Object.entries(multiplierResets)) {
            trace('Verifying multiplier resets for', arg('provider', provider));

            const { snapshots } = data;
            for (const snapshot of snapshots) {
                const { blockNumber, timestamp } = snapshot;

                const lastRemoveTime = contracts.CheckpointStore.checkpoint(provider).call({}, blockNumber);
                const lastClaimTime = contracts.StakingRewardsDistributionStore.lastClaimTime(provider).call(
                    {},
                    blockNumber
                );
                const actualTime = Math.max(lastRemoveTime.toNumber(), lastClaimTime.toNumber());

                // Verify snapshot values.
                if (timestamp == actualTime) {
                    error(
                        'Wrong snapshot multiplier reset',
                        arg('provider', provider),
                        arg('blockNumber', blockNumber),
                        arg('timestamp', reserveToken),
                        '[',
                        arg('expected', timestamp),
                        arg('actual', actualTime),
                        ']'
                    );
                }

                // Verify snapshot timestamps.
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp: blockTimeStamp } = block;
                if (timestamp != blockTimeStamp) {
                    error(
                        'Wrong snapshot timestamp',
                        arg('provider', provider),
                        arg('blockNumber', blockNumber),
                        arg('timestamp', reserveToken),
                        '[',
                        arg('expected', timestamp),
                        arg('actual', blockTimeStamp),
                        ']'
                    );
                }
            }

            // Verify that the snapshots array is sorted in an ascending order.
            for (let i = 0; i + 1 < snapshots.length - 1; ++i) {
                const snapshot1 = snapshots[i];
                const snapshot2 = snapshots[i + 1];
                if (snapshot1.timestamp > snapshot2.timestamp) {
                    error(
                        'Wrong snapshots order',
                        arg('provider', provider),
                        arg('snapshot1', snapshot1),
                        arg('snapshot2', snapshot2)
                    );
                }
            }
        }
    };

    const getMultiplierResets = async (data, fromBlock, toBlock) => {
        if (!data.multiplierResets) {
            data.multiplierResets = {};
        }

        await getPositionChanges(data.multiplierResets, fromBlock, toBlock);
        await getClaimedRewards(data.multiplierResets, fromBlock, toBlock);

        // TODO: re-enable verification after CheckpointStore is up to date
        // await verifyMultiplierResets(data.multiplierResets, toBlock);
        warning('Unable to verify multiplier resets without an up to date CheckpointStore contract');

        data.lastBlockNumber = toBlock;
    };

    const { settings, reorgOffset, web3, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    const dbDir = path.resolve(__dirname, '../data');
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

    const toBlock = latestBlock - reorgOffset;
    if (toBlock - fromBlock < reorgOffset) {
        error(
            'Unable to satisfy the reorg window. Please wait for additional',
            arg('blocks', reorgOffset - (toBlock - fromBlock + 1)),
            'to pass'
        );
    }

    info('Getting multiplier resets', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getMultiplierResets(data, fromBlock, toBlock);

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = getMultiplierResetsTask;
