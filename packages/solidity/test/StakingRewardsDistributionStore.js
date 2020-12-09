const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;

const StakingRewardsDistributionStore = contract.fromArtifact('TestStakingRewardsDistributionStore');

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');

describe('StakingRewardsDistributionStore', () => {
    let store;
    const owner = defaultSender;
    const nonOwner = accounts[1];
    const poolToken = accounts[8];

    const setTime = async (time) => {
        now = time;

        for (const t of [store]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    beforeEach(async () => {
        store = await StakingRewardsDistributionStore.new();

        await setTime(new BN(1000));
    });

    describe('construction', () => {
        it('should properly initialize roles', async () => {
            expect(await store.getRoleMemberCount.call(ROLE_OWNER)).to.be.bignumber.equal(new BN(1));

            expect(await store.getRoleAdmin.call(ROLE_OWNER)).to.eql(ROLE_OWNER);

            expect(await store.hasRole.call(ROLE_OWNER, owner)).to.be.true();
        });
    });

    describe('adding pools', () => {
        it('should revert when a non-owner attempts to add a pool', async () => {
            await expectRevert(
                store.addPoolProgram(poolToken, now, now.add(new BN(2000)), new BN(1000), { from: nonOwner }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when adding a zero address pool', async () => {
            await expectRevert(
                store.addPoolProgram(ZERO_ADDRESS, now, now.add(new BN(2000)), new BN(1000), { from: owner }),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert when adding a pool with invalid starting or ending times', async () => {
            await expectRevert(
                store.addPoolProgram(poolToken, new BN(0), now.add(new BN(2000)), new BN(1000), { from: owner }),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                store.addPoolProgram(poolToken, now.add(new BN(2000)), now, new BN(1000), { from: owner }),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                store.addPoolProgram(poolToken, now, now, new BN(1000), { from: owner }),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                store.addPoolProgram(poolToken, now.sub(new BN(100)), now.sub(new BN(1)), new BN(1000), {
                    from: owner
                }),
                'ERR_INVALID_DURATION'
            );
        });

        it('should revert when adding without any weekly rewards', async () => {
            await expectRevert(
                store.addPoolProgram(poolToken, now, now.add(new BN(2000)), new BN(0), { from: owner }),
                'ERR_ZERO_VALUE'
            );
        });

        it('should allow adding pools', async () => {
            expect(await store.isPoolParticipating.call(poolToken)).to.be.false();

            const startTime = now;
            const endTime = startTime.add(new BN(2000));
            const weeklyRewards = new BN(1000);
            const res = await store.addPoolProgram(poolToken, startTime, endTime, weeklyRewards, { from: owner });
            expectEvent(res, 'PoolProgramAdded', { startTime, endTime, weeklyRewards });

            expect(await store.isPoolParticipating.call(poolToken)).to.be.true();
            const pool = await store.poolProgram.call(poolToken);
            expect(pool[0]).to.be.bignumber.equal(startTime);
            expect(pool[1]).to.be.bignumber.equal(endTime);
            expect(pool[2]).to.be.bignumber.equal(weeklyRewards);

            const poolToken2 = accounts[9];

            expect(await store.isPoolParticipating.call(poolToken2)).to.be.false();

            const startTime2 = now.add(new BN(100000));
            const endTime2 = startTime2.add(new BN(6000));
            const weeklyRewards2 = startTime2.add(new BN(9999));
            const res2 = await store.addPoolProgram(poolToken2, startTime2, endTime2, weeklyRewards2, { from: owner });
            expectEvent(res2, 'PoolProgramAdded', {
                startTime: startTime2,
                endTime: endTime2,
                weeklyRewards: weeklyRewards2
            });

            expect(await store.isPoolParticipating.call(poolToken2)).to.be.true();
            const pool2 = await store.poolProgram.call(poolToken2);
            expect(pool2[0]).to.be.bignumber.equal(startTime2);
            expect(pool2[1]).to.be.bignumber.equal(endTime2);
            expect(pool2[2]).to.be.bignumber.equal(weeklyRewards2);
        });

        context('with a registered pool', async () => {
            beforeEach(async () => {
                const startTime = now;
                const endTime = startTime.add(new BN(2000));
                const weeklyRewards = new BN(1000);
                await store.addPoolProgram(poolToken, startTime, endTime, weeklyRewards, { from: owner });
                expect(await store.isPoolParticipating.call(poolToken)).to.be.true();
            });

            it('should revert when a non-owner attempts to remove a pool', async () => {
                await expectRevert(store.removePoolProgram(poolToken, { from: nonOwner }), 'ERR_ACCESS_DENIED');
            });

            it('should revert when removing an unregistered pool', async () => {
                const poolToken2 = accounts[9];
                await expectRevert(store.removePoolProgram(poolToken2, { from: owner }), 'ERR_POOL_NOT_PARTICIPATING');
            });

            it('should allow removing pools', async () => {
                const res = await store.removePoolProgram(poolToken, { from: owner });
                expectEvent(res, 'PoolProgramRemoved', { poolToken });

                expect(await store.isPoolParticipating.call(poolToken)).to.be.false();
            });

            it('should allow updating pools', async () => {
                const startTime2 = now.add(new BN(10000000));
                const endTime2 = startTime2.add(new BN(20000000));
                const weeklyRewards2 = new BN(1000);

                const res = await store.addPoolProgram(poolToken, startTime2, endTime2, weeklyRewards2, {
                    from: owner
                });
                expectEvent(res, 'PoolProgramUpdated', {
                    startTime: startTime2,
                    endTime: endTime2,
                    weeklyRewards: weeklyRewards2
                });

                const pool = await store.poolProgram.call(poolToken);
                expect(pool[0]).to.be.bignumber.equal(startTime2);
                expect(pool[1]).to.be.bignumber.equal(endTime2);
                expect(pool[2]).to.be.bignumber.equal(weeklyRewards2);
            });

            it('should revert when updating a pool with invalid starting or ending times', async () => {
                await expectRevert(
                    store.addPoolProgram(poolToken, new BN(0), now.add(new BN(2000)), new BN(1000), { from: owner }),
                    'ERR_INVALID_DURATION'
                );

                await expectRevert(
                    store.addPoolProgram(poolToken, now.add(new BN(2000)), now, new BN(1000), { from: owner }),
                    'ERR_INVALID_DURATION'
                );

                await expectRevert(
                    store.addPoolProgram(poolToken, now, now, new BN(1000), { from: owner }),
                    'ERR_INVALID_DURATION'
                );

                await expectRevert(
                    store.addPoolProgram(poolToken, now.sub(new BN(100)), now.sub(new BN(1)), new BN(1000), {
                        from: owner
                    }),
                    'ERR_INVALID_DURATION'
                );
            });
        });
    });

    describe('adding positions', () => {
        const providers = [accounts[1], accounts[2], accounts[1], accounts[4], accounts[2]];
        const ids = [new BN(123), new BN(2), new BN(3), new BN(10), new BN(555)];
        const startTimes = [new BN(0), new BN(0), new BN(0), new BN(0), new BN(0)];

        beforeEach(async () => {
            const startTime = now;
            const endTime = startTime.add(new BN(20000));
            const weeklyRewards = new BN(1000);

            await store.addPoolProgram(poolToken, startTime, endTime, weeklyRewards, { from: owner });
        });

        it('should revert when a non-owner attempts to add positions', async () => {
            await expectRevert(
                store.addPositions(poolToken, providers, ids, startTimes, { from: nonOwner }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when adding positions for a non-participating pool', async () => {
            const poolToken2 = accounts[9];
            await expectRevert(
                store.addPositions(poolToken2, providers, ids, startTimes, { from: owner }),
                'ERR_POOL_NOT_PARTICIPATING'
            );
        });

        it('should revert when adding positions with a zero address providers', async () => {
            await expectRevert(
                store.addPositions(poolToken, [providers[0], ZERO_ADDRESS], ids.slice(0, 2), startTimes.slice(0, 2), {
                    from: owner
                }),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert when adding positions with a future starting time', async () => {
            await expectRevert(
                store.addPositions(poolToken, providers.slice(0, 1), ids.slice(0, 1), [now.add(new BN(10000))], {
                    from: owner
                }),
                'ERR_INVALID_DURATION'
            );
        });

        it('should revert when adding with invalid lengths', async () => {
            await expectRevert(
                store.addPositions(poolToken, providers.slice(0, 2), ids, startTimes, { from: owner }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                store.addPositions(poolToken, providers, ids.slice(0, 2), startTimes, { from: owner }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                store.addPositions(poolToken, providers, ids, startTimes.slice(0, 2), { from: owner }),
                'ERR_INVALID_LENGTH'
            );
        });

        it('should allow adding positions', async () => {
            const providerPositions = {};
            for (let i = 0; i < providers.length; i++) {
                const provider = providers[i];
                const id = ids[i];
                expect(await store.positionExists.call(id)).to.be.false();

                if (!providerPositions[provider]) {
                    providerPositions[provider] = [];
                }

                providerPositions[provider].push(id);
            }

            const res = await store.addPositions(poolToken, providers, ids, startTimes, { from: owner });
            for (let i = 0; i < providers.length; i++) {
                const provider = providers[i];
                const id = ids[i];
                const startTime = startTimes[i];

                expectEvent(res, 'PositionOpened', { poolToken, provider, id, startTime });

                expect(await store.positionExists.call(id)).to.be.true();
                const position = await store.position.call(id);
                expect(position[0]).to.eql(provider);
                expect(position[1]).to.eql(poolToken);
                expect(position[2]).to.be.bignumber.equal(startTime);

                expect(await store.providerPositionsCount.call(provider)).to.be.bignumber.equal(
                    new BN(providerPositions[provider].length)
                );
                const positions = await store.providerPositions.call(provider);
                expect(positions.length).to.be.eql(providerPositions[provider].length);

                for (let j = 0; j < providerPositions[provider].length; j++) {
                    expect(positions[j]).to.be.bignumber.equal(new BN(providerPositions[provider][j]));
                    expect(await store.providerPosition(provider, j)).to.be.bignumber.equal(
                        new BN(providerPositions[provider][j])
                    );
                }
            }
        });

        context('with added positions', async () => {
            beforeEach(async () => {
                await store.addPositions(poolToken, providers, ids, startTimes, { from: owner });
            });

            it('should revert when adding positions already reserved ids', async () => {
                await expectRevert(
                    store.addPositions(poolToken, providers.slice().reverse(), ids, startTimes, { from: owner }),
                    'ERR_ID_ALREADY_EXISTS'
                );

                await expectRevert(
                    store.addPositions(poolToken, providers, ids.slice().reverse(), startTimes, { from: owner }),
                    'ERR_ID_ALREADY_EXISTS'
                );
            });

            it('should revert when a non-owner attempts to remove positions', async () => {
                await expectRevert(store.removePositions(ids, { from: nonOwner }), 'ERR_ACCESS_DENIED');
            });

            it('should revert when removing non-existing positions', async () => {
                await expectRevert(store.removePositions([new BN(10000000)], { from: owner }), 'ERR_INVALID_ID');
            });

            it('should allow removing positions', async () => {
                const res = await store.removePositions(ids, { from: owner });
                for (let i = 0; i < providers.length; i++) {
                    const provider = providers[i];
                    const id = ids[i];

                    expectEvent(res, 'PositionClosed', { poolToken, provider, id });

                    expect(await store.positionExists.call(id)).to.be.false();
                    await expectRevert(store.position.call(id), 'ERR_INVALID_ID');

                    expect(await store.providerPositionsCount.call(provider)).to.be.bignumber.equal(new BN(0));
                    const positions = await store.providerPositions.call(provider);
                    expect(positions.length).to.eql(0);
                }
            });

            it('should allow updating positions', async () => {
                const startTimes2 = [new BN(10), new BN(100), new BN(50), new BN(3), new BN(300)];
                const res = await store.addPositions(poolToken, providers, ids, startTimes2, { from: owner });
                for (let i = 0; i < providers.length; i++) {
                    const provider = providers[i];
                    const id = ids[i];
                    const startTime = startTimes2[i];

                    expectEvent(res, 'PositionUpdated', { poolToken, provider, id, startTime });

                    expect(await store.positionExists.call(id)).to.be.true();
                    const position = await store.position.call(id);
                    expect(position[0]).to.eql(provider);
                    expect(position[1]).to.eql(poolToken);
                    expect(position[2]).to.be.bignumber.equal(startTime);
                }
            });

            it('should revert when updating positions with invalid lengths', async () => {
                await expectRevert(
                    store.addPositions(poolToken, providers.slice(0, 2), ids, startTimes, { from: owner }),
                    'ERR_INVALID_LENGTH'
                );

                await expectRevert(
                    store.addPositions(poolToken, providers, ids.slice(0, 2), startTimes, { from: owner }),
                    'ERR_INVALID_LENGTH'
                );

                await expectRevert(
                    store.addPositions(poolToken, providers, ids, startTimes.slice(0, 2), { from: owner }),
                    'ERR_INVALID_LENGTH'
                );
            });
        });
    });

    describe('last claim times', () => {
        const provider = accounts[5];

        it('should revert when a non-owner attempts to update last claim time', async () => {
            await expectRevert(store.updateLastClaimTime(provider, { from: nonOwner }), 'ERR_ACCESS_DENIED');
        });

        it('should allow to update last claim time', async () => {
            expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(new BN(0));

            await setTime(now.add(new BN(1)));
            const res = await store.updateLastClaimTime(provider, { from: owner });
            expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(now);
            expectEvent(res, 'LastClaimTimeUpdated', { provider, claimTime: now });

            await setTime(now.add(new BN(100000)));
            const res2 = await store.updateLastClaimTime(provider, { from: owner });
            expectEvent(res2, 'LastClaimTimeUpdated', { provider, claimTime: now });
            expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(now);
        });
    });
});
