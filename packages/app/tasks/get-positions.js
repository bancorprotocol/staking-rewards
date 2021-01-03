const fs = require('fs');
const path = require('path');
const BN = require('bn.js');

const { trace, info, error, warning, arg } = require('../utils/logger');

const BATCH_SIZE = 5000;

const REMOVE_LIQUIDITY_SELECTOR = '0x782ed90c';
const REMOVE_LIQUIDITY_ABI = [
    {
        type: 'uint256',
        name: 'id'
    },
    {
        type: 'uint32',
        name: 'portion'
    }
];

const getPositionsTask = async (env) => {
    const getPosition = async (id, blockNumber) => {
        const position = await contracts.LiquidityProtectionStore.methods.protectedLiquidity(id).call({}, blockNumber);

        return {
            provider: position[0],
            poolToken: position[1],
            reserveToken: position[2],
            poolAmount: position[3],
            reserveAmount: position[4],
            timestamp: position[7]
        };
    };

    const addSnapshot = (snapshots, timestamp, blockNumber, amount) => {
        const snapshot = {
            timestamp,
            blockNumber,
            amount
        };
        const existing = snapshots.findIndex((i) => i.timestamp == timestamp && i.blockNumber == blockNumber);
        if (existing !== -1) {
            snapshots[existing] = snapshot;
        } else {
            snapshots.push(snapshot);
        }
    };

    const getPositionChanges = async (positions, fromBlock, toBlock) => {
        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection change events from',
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
                    case 'ProtectionAdded': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the new positions which didn't exist in the previous block and match them to
                        // this position.
                        let matches = [];
                        const currentBlockIds = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, blockNumber);
                        const prevBLockIds = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, blockNumber - 1);
                        const ids = currentBlockIds.filter((id) => !prevBLockIds.includes(id));

                        // If the we can't find to position in the current block, we can assume that it was created
                        // and transferred out in the same block, which means we'd get it in the next
                        // ProtectionAdded event. If this position was added and removed in the same block (which
                        // should be no longer possible in the newer versions), it's ok to ignore it since it won't
                        // be eligible for any rewards anyway.
                        if (currentBlockIds.length === 0) {
                            warning('Position no longer exists. Ignoring');

                            continue;
                        }

                        for (const id of ids) {
                            const position = await getPosition(id, blockNumber);

                            if (
                                new BN(position.poolToken).eq(new BN(poolToken)) &&
                                new BN(position.reserveToken).eq(new BN(reserveToken)) &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                // If the creation time is different, then we're handling an obsoleted transfer
                                // liquidity event.
                                if (position.timestamp != timestamp) {
                                    warning('Potentially unexpected transfer liquidity event');
                                }

                                matches.push(id);
                            }
                        }

                        if (matches.length === 0) {
                            error(
                                'Failed to fully match position ID. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        } else if (matches.length > 1) {
                            warning(
                                'Found more than a single exact match. Assuming that the entry belongs to the first unknown position',
                                arg('matches', matches.length)
                            );

                            // We've have found two identical position additions in the same block, so as long as
                            // we'd take the non-existing IDs first - we should be fine.
                            matches = matches.filter((id) => !positions[id]);
                        }

                        const id = matches[0];
                        const position = {
                            provider,
                            poolToken,
                            reserveToken,
                            poolAmount: new BN(poolAmount).toString(),
                            reserveAmount: new BN(reserveAmount).toString(),
                            timestamp,
                            snapshots: [
                                {
                                    timestamp,
                                    blockNumber,
                                    amount: new BN(reserveAmount).toString()
                                }
                            ]
                        };

                        trace(
                            'New position',
                            arg('id', id),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        positions[id] = position;

                        eventCount++;

                        break;
                    }

                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;
                        const prevReserveAmount = returnValues._prevReserveAmount;
                        const newReserveAmount = returnValues._newReserveAmount;
                        const prevPoolAmount = returnValues._prevPoolAmount;
                        const newPoolAmount = returnValues._newPoolAmount;

                        trace(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('prevPoolAmount', prevPoolAmount),
                            arg('newPoolAmount', newPoolAmount),
                            arg('prevReserveAmount', prevReserveAmount),
                            arg('newReserveAmount', newReserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the position ID in a previous block.
                        // Please note that we are ignore the case when a single position was added and removed in the
                        // same block.
                        const matches = [];
                        const ids = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, blockNumber - 1);
                        for (const id of ids) {
                            const position = positions[id];

                            if (
                                provider === position.provider &&
                                new BN(position.reserveAmount).eq(new BN(prevReserveAmount)) &&
                                new BN(position.poolAmount).eq(new BN(prevPoolAmount))
                            ) {
                                matches.push(id);
                            }
                        }

                        if (matches.length !== 1) {
                            error(
                                'Failed to fully match position ID. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const id = matches[0];
                        const position = positions[id];

                        if (new BN(position.reserveAmount).lte(new BN(newReserveAmount))) {
                            error(
                                'Update liquidity can only decrease the reserve token amount for',
                                arg('id', id),
                                arg('poolToken', position.poolToken),
                                arg('reserveToken', position.reserveToken),
                                '[',
                                arg('expected', position.reserveAmount),
                                'to be less than',
                                arg('actual', newReserveAmount),
                                ']'
                            );
                        }

                        trace(
                            'Position updated',
                            arg('id', id),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        position.poolAmount = new BN(newPoolAmount).toString();
                        position.reserveAmount = new BN(newReserveAmount).toString();

                        addSnapshot(position.snapshots, timestamp, blockNumber, position.reserveAmount);

                        eventCount++;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the position ID that existed in the previous block, but doesn't exist now.
                        // Please note that we are ignore the case when a single position was added and removed in the
                        // same block.
                        let matches = [];
                        const currentBlockIds = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, blockNumber);
                        const prevBLockIds = await contracts.LiquidityProtectionStore.methods
                            .protectedLiquidityIds(provider)
                            .call({}, blockNumber - 1);
                        const ids = prevBLockIds.filter((id) => !currentBlockIds.includes(id));

                        // If the we can't find to position in the previous block, we can assume that it was created
                        // and transferred out in the same block, which means we'd get it in the next
                        // ProtectionAdded event. If this position was added and removed in the same block (which
                        // should be no longer possible in the newer versions), it's ok to ignore it since it won't
                        // be eligible for any rewards anyway.
                        if (prevBLockIds.length === 0) {
                            warning('Position did not exist. Ignoring');

                            continue;
                        }

                        for (const id of ids) {
                            const position = positions[id];

                            if (
                                provider === position.provider &&
                                new BN(position.poolToken).eq(new BN(poolToken)) &&
                                new BN(position.reserveToken).eq(new BN(reserveToken)) &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                matches.push(id);
                            }
                        }

                        if (matches.length > 1) {
                            warning('Found too many matching position IDs. Attempting to decode the ID from tx data');

                            const tx = await web3.eth.getTransaction(transactionHash);
                            const { input } = tx;

                            if (!input.startsWith(REMOVE_LIQUIDITY_SELECTOR)) {
                                error('Failed to decode transaction', arg('tx', transactionHash));
                            }

                            const rawParams = input.slice(REMOVE_LIQUIDITY_SELECTOR.length);
                            const params = web3.eth.abi.decodeParameters(REMOVE_LIQUIDITY_ABI, `0x${rawParams}`);

                            const { id } = params;
                            const position = positions[id];

                            if (
                                provider === position.provider &&
                                new BN(position.poolToken).eq(new BN(poolToken)) &&
                                new BN(position.reserveToken).eq(new BN(reserveToken)) &&
                                new BN(position.poolAmount).eq(new BN(poolAmount)) &&
                                new BN(position.reserveAmount).eq(new BN(reserveAmount))
                            ) {
                                matches = [id];
                            } else {
                                error('Failed to match the decoded ID to the event', arg('id', id));
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match position ID. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const id = matches[0];
                        const position = positions[id];

                        if (!new BN(position.reserveAmount).eq(new BN(reserveAmount))) {
                            error(
                                'Remove liquidity can only decrease the entire reserve token amount for',
                                arg('id', id),
                                arg('poolToken', position.poolToken),
                                arg('reserveToken', position.reserveToken),
                                '[',
                                arg('expected', position.reserveAmount),
                                arg('actual', reserveAmount),
                                ']'
                            );
                        }

                        trace(
                            'Position removed',
                            arg('id', id),
                            arg('provider', position.provider),
                            arg('poolToken', position.poolToken),
                            arg('reserveToken', position.reserveToken),
                            arg('poolAmount', position.poolAmount),
                            arg('reserveAmount', position.reserveAmount),
                            arg('timestamp', position.timestamp)
                        );

                        position.poolAmount = 0;
                        position.reserveAmount = 0;

                        addSnapshot(position.snapshots, timestamp, blockNumber, position.reserveAmount);

                        eventCount++;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new position change events', arg('count', eventCount));
    };

    const verifyPositions = async (positions, toBlock) => {
        info('Verifying all positions at', arg('blockNumber', toBlock));

        for (const [id, data] of Object.entries(positions)) {
            trace('Verifying position historical reserve amounts', arg('id', id));

            const { poolToken, reserveToken, snapshots } = data;
            for (const snapshot of snapshots) {
                const { blockNumber, timestamp, amount } = snapshot;

                // Verify snapshot values.
                const pos = await getPosition(id, blockNumber);
                if (!new BN(amount).eq(new BN(pos.reserveAmount))) {
                    error(
                        'Wrong snapshot reserve amount',
                        arg('id', id),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('blockNumber', blockNumber),
                        arg('timestamp', reserveToken),
                        '[',
                        arg('expected', amount),
                        arg('actual', pos.reserveAmount),
                        ']'
                    );
                }

                // Verify snapshot timestamps.
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp: blockTimeStamp } = block;
                if (timestamp != blockTimeStamp) {
                    error(
                        'Wrong snapshot timestamp',
                        arg('id', id),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
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
                        arg('id', id),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('snapshot1', snapshot1),
                        arg('snapshot2', snapshot2)
                    );
                }
            }
        }
    };

    const getPositions = async (data, fromBlock, toBlock) => {
        if (!data.positions) {
            data.positions = {};
        }

        await getPositionChanges(data.positions, fromBlock, toBlock);
        await verifyPositions(data.positions, toBlock);

        data.lastBlockNumber = toBlock;
    };

    const { settings, reorgOffset, web3, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'positions.json');
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

    info('Getting protected positions', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getPositions(data, fromBlock, toBlock);

    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = getPositionsTask;
