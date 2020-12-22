const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;

const StakingRewardsStore = contract.fromArtifact('TestStakingRewardsStore');

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');

describe('StakingRewardsStore', () => {
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
        store = await StakingRewardsStore.new();

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
            const rewardRate = new BN(1000);
            const res = await store.addPoolProgram(poolToken, startTime, endTime, rewardRate, { from: owner });
            expectEvent(res, 'PoolProgramAdded', { startTime, endTime, rewardRate });

            expect(await store.isPoolParticipating.call(poolToken)).to.be.true();
            const pool = await store.poolProgram.call(poolToken);
            expect(pool[0]).to.be.bignumber.equal(startTime);
            expect(pool[1]).to.be.bignumber.equal(endTime);
            expect(pool[2]).to.be.bignumber.equal(rewardRate);

            const poolToken2 = accounts[9];

            expect(await store.isPoolParticipating.call(poolToken2)).to.be.false();

            const startTime2 = now.add(new BN(100000));
            const endTime2 = startTime2.add(new BN(6000));
            const rewardRate2 = startTime2.add(new BN(9999));
            const res2 = await store.addPoolProgram(poolToken2, startTime2, endTime2, rewardRate2, { from: owner });
            expectEvent(res2, 'PoolProgramAdded', {
                startTime: startTime2,
                endTime: endTime2,
                rewardRate: rewardRate2
            });

            expect(await store.isPoolParticipating.call(poolToken2)).to.be.true();
            const pool2 = await store.poolProgram.call(poolToken2);
            expect(pool2[0]).to.be.bignumber.equal(startTime2);
            expect(pool2[1]).to.be.bignumber.equal(endTime2);
            expect(pool2[2]).to.be.bignumber.equal(rewardRate2);
        });

        context('with a registered pool', async () => {
            beforeEach(async () => {
                const startTime = now;
                const endTime = startTime.add(new BN(2000));
                const rewardRate = new BN(1000);
                await store.addPoolProgram(poolToken, startTime, endTime, rewardRate, { from: owner });
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
                const rewardRate2 = new BN(1000);

                const res = await store.addPoolProgram(poolToken, startTime2, endTime2, rewardRate2, {
                    from: owner
                });
                expectEvent(res, 'PoolProgramUpdated', {
                    startTime: startTime2,
                    endTime: endTime2,
                    rewardRate: rewardRate2
                });

                const pool = await store.poolProgram.call(poolToken);
                expect(pool[0]).to.be.bignumber.equal(startTime2);
                expect(pool[1]).to.be.bignumber.equal(endTime2);
                expect(pool[2]).to.be.bignumber.equal(rewardRate2);
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
