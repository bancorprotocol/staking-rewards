const fs = require('fs');
const path = require('path');
const BN = require('bn.js');

const { trace, info, error, warning, arg } = require('../utils/logger');

const BATCH_SIZE = 5000;

const getLastRemovalTimes = async (env) => {
    const getPositionChanges = async (lastRemovalTimes, fromBlock, toBlock) => {
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

            const events = await contracts.LiquidityProtectionStoreOld.getPastEvents('allEvents', {
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

                        lastRemovalTimes[provider] = {
                            timestamp,
                            blockNumber
                        };

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

                        lastRemovalTimes[provider] = {
                            timestamp,
                            blockNumber
                        };

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new position remove events', arg('count', eventCount));
    };

    const filterLastRemovalTimes = async (lastRemovalTimes, toBlock) => {
        info('Filtering all last removal times resets at', arg('blockNumber', toBlock));

        const newLastRemovalTimes = {};
        let total = 0;
        let filtered = 0;

        for (const [provider, data] of Object.entries(lastRemovalTimes)) {
            trace('Filtering last removal time for', arg('provider', provider));

            const { timestamp, blockNumber } = data;

            const lastRemovalTime = await contracts.CheckpointStore.methods.checkpoint(provider).call({});
            if (new BN(lastRemovalTime).eq(new BN(timestamp))) {
                trace('Skipping already up to date last removal time for', arg('provider', provider));

                filtered++;

                continue;
            }

            // Verify timestamps.
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

            newLastRemovalTimes[provider] = { timestamp, blockNumber };

            total++;
        }

        info('Finished filtering all last removal times resets', arg('total', total), arg('filtered', filtered));

        return newLastRemovalTimes;
    };

    const getLastRemovalTimes = async (data, fromBlock, toBlock) => {
        if (!data.lastRemovalTimes) {
            data.lastRemovalTimes = {};
        }

        await getPositionChanges(data.lastRemovalTimes, fromBlock, toBlock);
        data.lastRemovalTimes = await filterLastRemovalTimes(data.lastRemovalTimes, toBlock);

        data.lastBlockNumber = toBlock;
    };

    const { settings, reorgOffset, web3, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'last-removal-times.json');
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

    info('Getting last removal times', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getLastRemovalTimes(data, fromBlock, toBlock);

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = getLastRemovalTimes;
