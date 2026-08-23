import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { AuthService } from '../../src/services/auth/auth.service';
import { SessionService } from '../../src/services/auth/session.service';
import { KycService } from '../../src/services/compliance/kyc.service';
import { AmlService } from '../../src/services/compliance/aml.service';
import { WalletService } from '../../src/services/wallet/wallet.service';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { totpService } from '../../src/services/auth/totp.service';

describe('Phase 7.2: PostgreSQL KYC & AML Integration Tests', () => {
  let pgPool: PostgresDatabasePool;
  let authService: AuthService;
  let kycService: KycService;
  let amlService: AmlService;
  let walletService: WalletService;
  let ledgerService: LedgerService;

  let userId: string;
  let accountId: string;
  let adminUserId: string;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool();
    await pgPool.connect();

    const migrator = new SchemaMigrator(undefined, pgPool);
    await migrator.runMigrations();

    const sessionService = new SessionService(pgPool);
    authService = new AuthService(pgPool, sessionService, totpService);
    ledgerService = new LedgerService(pgPool);
    kycService = new KycService(pgPool);
    amlService = new AmlService(pgPool, kycService);
    walletService = new WalletService(pgPool, ledgerService, amlService);

    // Create user
    const userUniq = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const userRes = await authService.signup({
      email: `pg_kyc_user_${userUniq}_${Date.now()}@test.exchange`,
      password: 'Password123!SecurePg',
      username: `pgkyc_${userUniq}`,
    });
    userId = userRes.user.id;
    accountId = userRes.user.accounts.find((a) => a.type === 'SPOT')!.id;

    // Create admin
    const adminUniq = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const adminRes = await authService.signup({
      email: `pg_kyc_admin_${adminUniq}_${Date.now()}@test.exchange`,
      password: 'Password123!SecurePg',
      username: `pgadm_${adminUniq}`,
    });
    adminUserId = adminRes.user.id;

    // Deposit test collateral
    await walletService.paperDeposit({
      adminUserId,
      targetAccountId: accountId,
      asset: 'USDT',
      amount: '20000',
      referenceId: `pg-seed-${Date.now()}`,
    });
  });

  afterAll(async () => {
    if (pgPool) {
      await pgPool.close();
    }
  });

  it('1. Verifies migration 012 applied and user_kyc_profiles table exists in PostgreSQL', async () => {
    const tableRes = await pgPool.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'user_kyc_profiles'"
    );
    expect(tableRes.rows.length).toBe(1);

    const defaultProfile = await kycService.getProfile(userId);
    expect(defaultProfile.tier).toBe('TIER_0');
    expect(defaultProfile.status).toBe('UNVERIFIED');
  });

  it('2. Submits and approves KYC in real PostgreSQL database', async () => {
    const submitted = await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Postgres',
      lastName: 'Trader',
      dateOfBirth: '1993-04-12',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'PG998877',
      idDocumentFrontUrl: 'https://cdn.novacex.io/kyc/front.png',
    });

    expect(submitted.status).toBe('PENDING_REVIEW');

    // Verify row in real postgres
    const dbRow = await pgPool.query<any>(
      'SELECT * FROM user_kyc_profiles WHERE user_id = $1',
      [userId]
    );
    expect(dbRow.rows.length).toBe(1);
    expect(dbRow.rows[0].status).toBe('PENDING_REVIEW');
    expect(dbRow.rows[0].nationality).toBe('USA');

    // Review & approve
    const approved = await kycService.reviewKyc({
      reviewerId: adminUserId,
      userId,
      approved: true,
      assignedTier: 'TIER_1',
    });

    expect(approved.status).toBe('VERIFIED');
    expect(approved.tier).toBe('TIER_1');

    // Verify updated status in PostgreSQL
    const verifiedDbRow = await pgPool.query<any>(
      'SELECT tier, status FROM user_kyc_profiles WHERE user_id = $1',
      [userId]
    );
    expect(verifiedDbRow.rows[0].status).toBe('VERIFIED');
    expect(verifiedDbRow.rows[0].tier).toBe('TIER_1');
  });

  it('3. Enforces 24h withdrawal limit on PostgreSQL ledger entries', async () => {
    // 1st withdrawal of 1,000 USDT -> Success (Limit 2,000)
    const tx1 = await walletService.paperWithdraw({
      userId,
      accountId,
      asset: 'USDT',
      amount: '1000',
      referenceId: `pg-wd-${Date.now()}-1`,
      destinationAddress: '0xValidWithdrawalAddress123',
    });
    expect(tx1.status).toBe('COMPLETED');

    // 2nd withdrawal of 1,200 USDT -> Fails (1000 + 1200 = 2200 > 2000)
    await expect(
      walletService.paperWithdraw({
        userId,
        accountId,
        asset: 'USDT',
        amount: '1200',
        referenceId: `pg-wd-${Date.now()}-2`,
        destinationAddress: '0xValidWithdrawalAddress123',
      })
    ).rejects.toThrow(/Withdrawal exceeds 24-hour KYC limit/);
  });

  it('4. Rejects withdrawal targeting an address listed in sanctioned_addresses table', async () => {
    const sanctionedAddr = '0xSanctionedPgTargetAddress999';
    await amlService.addSanctionedAddress(sanctionedAddr, 'OFAC SDN List', 'OFAC');

    // Verify row in PostgreSQL
    const sDb = await pgPool.query<any>(
      'SELECT address, is_active FROM sanctioned_addresses WHERE address = $1',
      [sanctionedAddr]
    );
    expect(sDb.rows.length).toBe(1);
    expect(sDb.rows[0].is_active).toBe(true);

    await expect(
      walletService.paperWithdraw({
        userId,
        accountId,
        asset: 'USDT',
        amount: '100',
        referenceId: `pg-wd-${Date.now()}-sanction`,
        destinationAddress: sanctionedAddr,
      })
    ).rejects.toThrow(/flagged on sanctions blacklist/);
  });
});
