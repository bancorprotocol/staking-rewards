const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;

const TestERC20Token = contract.fromArtifact('TestERC20Token');
const TestConverter = contract.fromArtifact('TestConverter');
const TestPoolToken = contract.fromArtifact('TestPoolToken');
const StakingRewardsStore = contract.fromArtifact('TestStakingRewardsStore');

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const NETWORK_TOKEN_REWARDS_SHARE = new BN(700000); // 70%
const BASE_TOKEN_REWARDS_SHARE = new BN(300000); // 30%

describe('StakingRewardsStore', () => {
    let store;
    let reserveToken;
    let networkToken;
    let poolToken;
    let poolToken2;
    const owner = defaultSender;
    const nonOwner = accounts[1];

    const setTime = async (time) => {
        now = time;

        for (const t of [store]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    const getPoolProgram = async (poolToken) => {
        const data = await store.poolProgram.call(poolToken.address);

        return {
            startTime: data[0],
            endTime: data[1],
            rewardRate: data[2],
            reserveTokens: data[3],
            rewardShares: data[4]
        };
    };

    const getPoolRewards = async (poolToken, reserveToken) => {
        const data = await store.rewards.call(poolToken.address, reserveToken.address);

        return {
            lastUpdateTime: data[0],
            rewardPerToken: data[1],
            totalReserveAmount: data[2]
        };
    };

    const getProviderRewards = async (provider, poolToken, reserveToken) => {
        const data = await store.providerRewards.call(provider, poolToken.address, reserveToken.address);

        return {
            rewardPerToken: data[0],
            pendingBaseRewards: data[1],
            effectiveStakingTime: data[2],
            baseRewardsDebt: data[3],
            baseRewardsDebtMultiplier: data[4],
            reserveAmount: data[5]
        };
    };

    beforeEach(async () => {
        networkToken = await TestERC20Token.new('TKN1', 'TKN1');
        reserveToken = await TestERC20Token.new('RSV1', 'RSV1');

        poolToken = await TestPoolToken.new('POOL1', 'POOL1');
        const converter = await TestConverter.new(poolToken.address, networkToken.address, reserveToken.address);
        await poolToken.setOwner(converter.address);

        poolToken2 = await TestPoolToken.new('POOL2', 'POOL2');
        const converter2 = await TestConverter.new(poolToken2.address, reserveToken.address, networkToken.address);
        await poolToken2.setOwner(converter2.address);

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

    describe('pool programs', () => {
        it('should revert when a non-owner attempts to add a pool', async () => {
            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(1000),
                    { from: nonOwner }
                ),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when adding a zero address pool', async () => {
            await expectRevert(
                store.addPoolProgram(
                    ZERO_ADDRESS,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(1000),
                    { from: owner }
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert when adding a pool with invalid ending time', async () => {
            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.sub(new BN(1)),
                    new BN(1000),
                    {
                        from: owner
                    }
                ),
                'ERR_INVALID_DURATION'
            );
        });

        it('should revert when adding a pool with reward shares', async () => {
            const invalidToken = accounts[5];

            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE.sub(new BN(1)), BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(1000),
                    {
                        from: owner
                    }
                ),
                'ERR_INVALID_REWARD_SHARES'
            );
        });

        it('should revert when adding a pool with invalid reserve tokens', async () => {
            const invalidToken = accounts[5];

            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [invalidToken, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(1000),
                    {
                        from: owner
                    }
                ),
                'ERR_INVALID_RESERVE_TOKENS'
            );

            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, invalidToken],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(1000),
                    {
                        from: owner
                    }
                ),
                'ERR_INVALID_RESERVE_TOKENS'
            );
        });

        it('should revert when adding without any weekly rewards', async () => {
            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(2000)),
                    new BN(0),
                    { from: owner }
                ),
                'ERR_ZERO_VALUE'
            );
        });

        it('should allow managing pools', async () => {
            expect(await store.isParticipatingReserve.call(poolToken.address, networkToken.address)).to.be.false();
            expect(await store.isParticipatingReserve.call(poolToken.address, reserveToken.address)).to.be.false();

            const startTime = now;
            const endTime = startTime.add(new BN(2000));
            const rewardRate = new BN(1000);
            const res = await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                endTime,
                rewardRate,
                { from: owner }
            );
            expectEvent(res, 'PoolProgramAdded', {
                poolToken: poolToken.address,
                startTime,
                endTime,
                rewardRate
            });

            expect(await store.isParticipatingReserve.call(poolToken.address, networkToken.address)).to.be.true();
            expect(await store.isParticipatingReserve.call(poolToken.address, reserveToken.address)).to.be.true();

            const pool = await getPoolProgram(poolToken);
            expect(pool.startTime).to.be.bignumber.equal(startTime);
            expect(pool.endTime).to.be.bignumber.equal(endTime);
            expect(pool.rewardRate).to.be.bignumber.equal(rewardRate);
            expect(pool.reserveTokens[0]).to.eql(networkToken.address);
            expect(pool.reserveTokens[1]).to.eql(reserveToken.address);
            expect(pool.rewardShares[0]).to.be.bignumber.equal(NETWORK_TOKEN_REWARDS_SHARE);
            expect(pool.rewardShares[1]).to.be.bignumber.equal(BASE_TOKEN_REWARDS_SHARE);

            await expectRevert(
                store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(1)),
                    rewardRate,
                    { from: owner }
                ),
                'ERR_ALREADY_SUPPORTED'
            );

            expect(await store.isParticipatingReserve.call(poolToken2.address, networkToken.address)).to.be.false();
            expect(await store.isParticipatingReserve.call(poolToken2.address, reserveToken.address)).to.be.false();

            await setTime(now.add(new BN(100000)));

            const startTime2 = now;
            const endTime2 = startTime2.add(new BN(6000));
            const rewardRate2 = startTime2.add(new BN(9999));
            const res2 = await store.addPoolProgram(
                poolToken2.address,
                [reserveToken.address, networkToken.address],
                [BASE_TOKEN_REWARDS_SHARE, NETWORK_TOKEN_REWARDS_SHARE],
                endTime2,
                rewardRate2,
                {
                    from: owner
                }
            );
            expectEvent(res2, 'PoolProgramAdded', {
                poolToken: poolToken2.address,
                startTime: startTime2,
                endTime: endTime2,
                rewardRate: rewardRate2
            });

            expect(await store.isParticipatingReserve.call(poolToken2.address, networkToken.address)).to.be.true();
            expect(await store.isParticipatingReserve.call(poolToken2.address, reserveToken.address)).to.be.true();

            const pool2 = await getPoolProgram(poolToken2);
            expect(pool2.startTime).to.be.bignumber.equal(startTime2);
            expect(pool2.endTime).to.be.bignumber.equal(endTime2);
            expect(pool2.rewardRate).to.be.bignumber.equal(rewardRate2);
            expect(pool2.reserveTokens[0]).to.eql(reserveToken.address);
            expect(pool2.reserveTokens[1]).to.eql(networkToken.address);
            expect(pool2.rewardShares[0]).to.be.bignumber.equal(BASE_TOKEN_REWARDS_SHARE);
            expect(pool2.rewardShares[1]).to.be.bignumber.equal(NETWORK_TOKEN_REWARDS_SHARE);

            await expectRevert(
                store.addPoolProgram(
                    poolToken2.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    now.add(new BN(1)),
                    rewardRate,
                    { from: owner }
                ),
                'ERR_ALREADY_SUPPORTED'
            );
        });

        context('with a registered pool', async () => {
            beforeEach(async () => {
                const startTime = now;
                const endTime = startTime.add(new BN(2000));
                const rewardRate = new BN(1000);
                await store.addPoolProgram(
                    poolToken.address,
                    [networkToken.address, reserveToken.address],
                    [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                    endTime,
                    rewardRate,
                    { from: owner }
                );
            });

            it('should revert when a non-owner attempts to remove a pool', async () => {
                await expectRevert(store.removePoolProgram(poolToken.address, { from: nonOwner }), 'ERR_ACCESS_DENIED');
            });

            it('should revert when removing an unregistered pool', async () => {
                await expectRevert(
                    store.removePoolProgram(poolToken2.address, { from: owner }),
                    'ERR_POOL_NOT_PARTICIPATING'
                );
            });

            it('should allow removing pools', async () => {
                const res = await store.removePoolProgram(poolToken.address, { from: owner });
                expectEvent(res, 'PoolProgramRemoved', { poolToken: poolToken.address });

                expect(await store.isParticipatingReserve.call(poolToken.address, networkToken.address)).to.be.false();
                expect(await store.isParticipatingReserve.call(poolToken.address, reserveToken.address)).to.be.false();
            });
        });
    });

    describe('provider liquidity', () => {
        const provider = accounts[5];
        const provider2 = accounts[6];

        beforeEach(async () => {
            const startTime = now;
            const endTime = startTime.add(new BN(2000));
            const rewardRate = new BN(1000);
            await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                endTime,
                rewardRate,
                { from: owner }
            );
            await store.addPoolProgram(
                poolToken2.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                endTime,
                rewardRate,
                { from: owner }
            );
        });

        it('should revert when a non-owner attempts to add provider liquidity', async () => {
            await expectRevert(
                store.addProviderLiquidity(provider, poolToken.address, reserveToken.address, new BN(1000), {
                    from: nonOwner
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should add provider liquidity', async () => {
            const reserveAmount = new BN(1000);
            await store.addProviderLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                from: owner
            });

            let poolData = await getPoolRewards(poolToken, reserveToken);
            expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
            expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount);

            let providerData = await getProviderRewards(provider, poolToken, reserveToken);
            expect(providerData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(providerData.pendingBaseRewards).to.be.bignumber.equal(new BN(0));
            expect(providerData.effectiveStakingTime).to.be.bignumber.equal(now);
            expect(providerData.baseRewardsDebt).to.be.bignumber.equal(new BN(0));
            expect(providerData.baseRewardsDebtMultiplier).to.be.bignumber.equal(new BN(0));
            expect(providerData.reserveAmount).to.be.bignumber.equal(reserveAmount);

            let providerPools = await store.poolsByProvider.call(provider);
            expect(providerPools).to.be.equalTo([poolToken.address]);

            await store.addProviderLiquidity(provider, poolToken2.address, reserveToken.address, reserveAmount, {
                from: owner
            });

            poolData = await getPoolRewards(poolToken2, reserveToken);
            expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
            expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount);

            const reserveAmount2 = new BN(9999);
            await store.addProviderLiquidity(provider2, poolToken.address, reserveToken.address, reserveAmount2, {
                from: owner
            });

            providerPools = await store.poolsByProvider.call(provider);
            expect(providerPools).to.be.equalTo([poolToken.address, poolToken2.address]);

            poolData = await getPoolRewards(poolToken, reserveToken);
            expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
            expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount.add(reserveAmount2));

            providerData = await getProviderRewards(provider2, poolToken, reserveToken);
            expect(providerData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(providerData.pendingBaseRewards).to.be.bignumber.equal(new BN(0));
            expect(providerData.effectiveStakingTime).to.be.bignumber.equal(now);
            expect(providerData.baseRewardsDebt).to.be.bignumber.equal(new BN(0));
            expect(providerData.baseRewardsDebtMultiplier).to.be.bignumber.equal(new BN(0));
            expect(providerData.reserveAmount).to.be.bignumber.equal(reserveAmount2);

            providerPools = await store.poolsByProvider.call(provider2);
            expect(providerPools).to.be.equalTo([poolToken.address]);
        });

        context('with provider liquidity', async () => {
            const reserveAmount = new BN(1000);

            beforeEach(async () => {
                await store.addProviderLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                    from: owner
                });
            });

            it('should revert when a non-owner attempts to remove provider liquidity', async () => {
                await expectRevert(
                    store.removeProviderLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                        from: nonOwner
                    }),
                    'ERR_ACCESS_DENIED'
                );
            });

            it('should remove provider liquidity', async () => {
                const removedReserveAmount = new BN(100);
                await store.removeProviderLiquidity(
                    provider,
                    poolToken.address,
                    reserveToken.address,
                    removedReserveAmount,
                    {
                        from: owner
                    }
                );

                let poolData = await getPoolRewards(poolToken, reserveToken);
                expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
                expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
                expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount.sub(removedReserveAmount));

                let providerData = await getProviderRewards(provider, poolToken, reserveToken);
                expect(providerData.rewardPerToken).to.be.bignumber.equal(new BN(0));
                expect(providerData.pendingBaseRewards).to.be.bignumber.equal(new BN(0));
                expect(providerData.effectiveStakingTime).to.be.bignumber.equal(now);
                expect(providerData.baseRewardsDebt).to.be.bignumber.equal(new BN(0));
                expect(providerData.baseRewardsDebtMultiplier).to.be.bignumber.equal(new BN(0));
                expect(providerData.reserveAmount).to.be.bignumber.equal(reserveAmount.sub(removedReserveAmount));

                let providerPools = await store.poolsByProvider.call(provider);
                expect(providerPools).to.be.equalTo([poolToken.address]);

                await store.removeProviderLiquidity(
                    provider,
                    poolToken.address,
                    reserveToken.address,
                    reserveAmount.sub(removedReserveAmount),
                    {
                        from: owner
                    }
                );

                poolData = await getPoolRewards(poolToken, reserveToken);
                expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
                expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
                expect(poolData.totalReserveAmount).to.be.bignumber.equal(new BN(0));

                providerData = await getProviderRewards(provider, poolToken, reserveToken);
                expect(providerData.rewardPerToken).to.be.bignumber.equal(new BN(0));
                expect(providerData.pendingBaseRewards).to.be.bignumber.equal(new BN(0));
                expect(providerData.effectiveStakingTime).to.be.bignumber.equal(now);
                expect(providerData.baseRewardsDebt).to.be.bignumber.equal(new BN(0));
                expect(providerData.baseRewardsDebtMultiplier).to.be.bignumber.equal(new BN(0));
                expect(providerData.reserveAmount).to.be.bignumber.equal(new BN(0));

                providerPools = await store.poolsByProvider.call(provider);
                expect(providerPools).to.be.equalTo([]);
            });
        });
    });

    describe('pool rewards data', () => {
        const provider = accounts[5];
        const reserveAmount = new BN(1000);

        beforeEach(async () => {
            const startTime = now;
            const endTime = startTime.add(new BN(2000));
            const rewardRate = new BN(1000);
            await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                endTime,
                rewardRate,
                { from: owner }
            );

            await store.addProviderLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                from: owner
            });
        });

        it('should revert when a non-owner attempts to update pool rewards', async () => {
            await expectRevert(
                store.updateRewardData(poolToken.address, reserveToken.address, new BN(1000), new BN(0), {
                    from: nonOwner
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should update pool rewards data', async () => {
            let poolData = await getPoolRewards(poolToken, reserveToken);
            expect(poolData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(poolData.lastUpdateTime).to.be.bignumber.equal(new BN(0));
            expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount);

            const rewardPerToken = new BN(10000);
            const lastUpdateTime = new BN(123);
            await store.updateRewardData(poolToken.address, reserveToken.address, rewardPerToken, lastUpdateTime, {
                from: owner
            });

            poolData = await getPoolRewards(poolToken, reserveToken);
            expect(poolData.rewardPerToken).to.be.bignumber.equal(rewardPerToken);
            expect(poolData.lastUpdateTime).to.be.bignumber.equal(lastUpdateTime);
            expect(poolData.totalReserveAmount).to.be.bignumber.equal(reserveAmount);
        });
    });

    describe('provider rewards data', () => {
        const provider = accounts[5];
        const reserveAmount = new BN(1000);

        beforeEach(async () => {
            const startTime = now;
            const endTime = startTime.add(new BN(2000));
            const rewardRate = new BN(1000);
            await store.addPoolProgram(
                poolToken.address,
                [networkToken.address, reserveToken.address],
                [NETWORK_TOKEN_REWARDS_SHARE, BASE_TOKEN_REWARDS_SHARE],
                endTime,
                rewardRate,
                { from: owner }
            );

            await store.addProviderLiquidity(provider, poolToken.address, reserveToken.address, reserveAmount, {
                from: owner
            });
        });

        it('should revert when a non-owner attempts to update provider rewards data', async () => {
            await expectRevert(
                store.updateProviderRewardData(
                    provider,
                    poolToken.address,
                    reserveToken.address,
                    new BN(1000),
                    new BN(0),
                    new BN(0),
                    new BN(0),
                    new BN(0),
                    {
                        from: nonOwner
                    }
                ),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should update provider rewards data', async () => {
            let providerData = await getProviderRewards(provider, poolToken, reserveToken);
            expect(providerData.rewardPerToken).to.be.bignumber.equal(new BN(0));
            expect(providerData.pendingBaseRewards).to.be.bignumber.equal(new BN(0));
            expect(providerData.effectiveStakingTime).to.be.bignumber.equal(now);

            const rewardPerToken = new BN(10000);
            const pendingBaseRewards = new BN(123);
            const effectiveStakingTime = new BN(11111);
            const baseRewardsDebt = new BN(9999999);
            const baseRewardsDebtMultiplier = new BN(100000);
            await store.updateProviderRewardData(
                provider,
                poolToken.address,
                reserveToken.address,
                rewardPerToken,
                pendingBaseRewards,
                effectiveStakingTime,
                baseRewardsDebt,
                baseRewardsDebtMultiplier,
                {
                    from: owner
                }
            );

            providerData = await getProviderRewards(provider, poolToken, reserveToken);
            expect(providerData.rewardPerToken).to.be.bignumber.equal(rewardPerToken);
            expect(providerData.pendingBaseRewards).to.be.bignumber.equal(pendingBaseRewards);
            expect(providerData.effectiveStakingTime).to.be.bignumber.equal(effectiveStakingTime);
            expect(providerData.baseRewardsDebt).to.be.bignumber.equal(baseRewardsDebt);
            expect(providerData.baseRewardsDebtMultiplier).to.be.bignumber.equal(baseRewardsDebtMultiplier);
        });
    });

    describe('last claim times', () => {
        const provider = accounts[5];

        it('should revert when a non-owner attempts to update last claim time', async () => {
            await expectRevert(store.updateProviderLastClaimTime(provider, { from: nonOwner }), 'ERR_ACCESS_DENIED');
        });

        it('should allow to update last claim time', async () => {
            expect(await store.lastProviderClaimTime.call(provider)).to.be.bignumber.equal(new BN(0));

            await setTime(now.add(new BN(1)));
            const res = await store.updateProviderLastClaimTime(provider, { from: owner });
            expect(await store.lastProviderClaimTime.call(provider)).to.be.bignumber.equal(now);
            expectEvent(res, 'LastProviderClaimTimeUpdated', { provider, claimTime: now });

            await setTime(now.add(new BN(100000)));
            const res2 = await store.updateProviderLastClaimTime(provider, { from: owner });
            expectEvent(res2, 'LastProviderClaimTimeUpdated', { provider, claimTime: now });
            expect(await store.lastProviderClaimTime.call(provider)).to.be.bignumber.equal(now);
        });
    });
});
