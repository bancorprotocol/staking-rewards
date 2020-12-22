const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, constants, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;
const { duration } = time;

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_WHITELIST_ADMIN = web3.utils.keccak256('ROLE_WHITELIST_ADMIN');

const TestERC20Token = contract.fromArtifact('TestERC20Token');
const StakingRewardsSettings = contract.fromArtifact('TestStakingRewardsSettings');

const BIG_POOL_WEEKLY_REWARDS = new BN(200000).mul(new BN(10).pow(new BN(18)));
const REWARDS_DURATION = duration.weeks(12);

describe('StakingRewardsSettings', () => {
    const owner = defaultSender;
    const nonOwner = accounts[1];

    let baseToken;
    let baseToken2;
    let networkToken;
    let poolToken;
    let poolToken2;
    let settings;
    let now = new BN(10000);

    before(async () => {
        networkToken = await TestERC20Token.new('BNT', 'BNT');
        baseToken = await TestERC20Token.new('RSV1', 'RSV1');
        baseToken2 = await TestERC20Token.new('RSV2', 'RSV2');
        poolToken = await TestERC20Token.new('POOL1', 'POOL1');
        poolToken2 = await TestERC20Token.new('POOL2', 'POOL2');
    });

    beforeEach(async () => {
        settings = await StakingRewardsSettings.new(networkToken.address);
        await settings.setTime(now);
    });

    it('should properly initialize roles', async () => {
        expect(await settings.getRoleMemberCount.call(ROLE_OWNER)).to.be.bignumber.equal(new BN(1));
        expect(await settings.getRoleMemberCount.call(ROLE_WHITELIST_ADMIN)).to.be.bignumber.equal(new BN(0));

        expect(await settings.getRoleAdmin.call(ROLE_OWNER)).to.eql(ROLE_OWNER);
        expect(await settings.getRoleAdmin.call(ROLE_WHITELIST_ADMIN)).to.eql(ROLE_OWNER);

        expect(await settings.hasRole.call(ROLE_OWNER, owner)).to.be.true();
        expect(await settings.hasRole.call(ROLE_WHITELIST_ADMIN, owner)).to.be.false();
    });

    describe('whitelisted pools', () => {
        const admin = accounts[2];

        beforeEach(async () => {
            await settings.grantRole(ROLE_WHITELIST_ADMIN, admin, { from: owner });
        });

        const testAddPool = async (poolToken, start, end, weeklyRewards) => {
            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.false();
            expect(await settings.participatingPools.call()).not.to.be.containing(poolToken.address);

            const res = await settings.addPoolToRewardsWhitelist(poolToken.address, start, end, weeklyRewards, {
                from: admin
            });

            expectEvent(res, 'PoolRewardsWhitelistAdded', {
                _poolToken: poolToken.address,
                _startTime: start,
                _endTime: end,
                _weeklyRewards: weeklyRewards
            });

            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.true();
            expect(await settings.participatingPools.call()).to.be.containing(poolToken.address);

            const poolRewards = await settings.poolRewards.call(poolToken.address);
            expect(poolRewards[0]).to.be.bignumber.equal(start);
            expect(poolRewards[1]).to.be.bignumber.equal(end);
            expect(poolRewards[2]).to.be.bignumber.equal(weeklyRewards);
        };

        const testRemovePool = async (poolToken) => {
            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.true();
            expect(await settings.participatingPools.call()).to.be.containing(poolToken.address);

            const res = await settings.removePoolFromRewardsWhitelist(poolToken.address, { from: admin });

            expectEvent(res, 'PoolRewardsWhitelistRemoved', {
                _poolToken: poolToken.address
            });

            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.false();
            expect(await settings.participatingPools.call()).not.to.be.containing(poolToken.address);
        };

        it('should revert when a non admin attempts to add a whitelisted pool', async () => {
            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    now,
                    now.add(REWARDS_DURATION),
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: nonOwner
                    }
                ),
                'ERR_ACCESS_DENIED'
            );
            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.false();
        });

        it('should revert when an admin attempts to add an invalid pool', async () => {
            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    ZERO_ADDRESS,
                    now,
                    now.add(REWARDS_DURATION),
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: admin
                    }
                ),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });

        it('should revert when a non admin attempts to add a pool with invalid starting or ending times', async () => {
            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    new BN(0),
                    now.add(REWARDS_DURATION),
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: admin
                    }
                ),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    now.add(REWARDS_DURATION),
                    now,
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: admin
                    }
                ),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                settings.addPoolToRewardsWhitelist(poolToken.address, now, now, BIG_POOL_WEEKLY_REWARDS, {
                    from: admin
                }),
                'ERR_INVALID_DURATION'
            );

            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    now.sub(new BN(10000)),
                    now.sub(new BN(1)),
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: admin
                    }
                ),
                'ERR_INVALID_DURATION'
            );
        });

        it('should revert when a non admin attempts to add a pool with invalid weekly rewards', async () => {
            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    now.sub(new BN(1000)),
                    now.add(REWARDS_DURATION),
                    new BN(0),
                    {
                        from: admin
                    }
                ),
                'ERR_INVALID_WEEKLY_REWARDS'
            );
        });

        it('should revert when a non admin attempts to remove a whitelisted pool', async () => {
            await settings.addPoolToRewardsWhitelist(
                poolToken.address,
                now,
                now.add(REWARDS_DURATION),
                BIG_POOL_WEEKLY_REWARDS,
                { from: admin }
            );
            await expectRevert(
                settings.removePoolFromRewardsWhitelist(poolToken.address, { from: nonOwner }),
                'ERR_ACCESS_DENIED'
            );
            expect(await settings.isPoolWhitelisted.call(poolToken.address)).to.be.true();
        });

        it('should revert when an admin attempts to add a whitelisted pool which is already whitelisted', async () => {
            await settings.addPoolToRewardsWhitelist(
                poolToken.address,
                now,
                now.add(REWARDS_DURATION),
                BIG_POOL_WEEKLY_REWARDS,
                { from: admin }
            );
            await expectRevert(
                settings.addPoolToRewardsWhitelist(
                    poolToken.address,
                    now,
                    now.add(REWARDS_DURATION),
                    BIG_POOL_WEEKLY_REWARDS,
                    {
                        from: admin
                    }
                ),
                'ERR_POOL_ALREADY_WHITELISTED'
            );
        });

        it('should revert when an admin attempts to remove a whitelisted pool which is not yet whitelisted', async () => {
            await expectRevert(
                settings.removePoolFromRewardsWhitelist(poolToken.address, { from: admin }),
                'ERR_POOL_NOT_WHITELISTED'
            );
        });

        it('should succeed when an admin attempts to add a whitelisted pool', async () => {
            await testAddPool(poolToken, now, now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
            await testAddPool(poolToken2, now.sub(new BN(100)), now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
        });

        it('should succeed when the owner attempts to remove a whitelisted pool', async () => {
            await testAddPool(poolToken, now, now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
            await testAddPool(poolToken2, now, now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
            await testRemovePool(poolToken);
            await testRemovePool(poolToken2);
        });

        it('should succeed when an admin attempts to readd a whitelisted pool', async () => {
            await testAddPool(poolToken, now, now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
            await testRemovePool(poolToken);
            await testAddPool(poolToken, now, now.add(REWARDS_DURATION), BIG_POOL_WEEKLY_REWARDS);
        });
    });
});
