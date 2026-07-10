import { PasswordHashService } from './password-hash.service';

describe('PasswordHashService', () => {
  const service = new PasswordHashService();
  const password = 'correct-horse-42';

  it('hashes and verifies a password', async () => {
    const hash = await service.hash(password);
    expect(hash).toMatch(/^scrypt-v1\$N=16384,r=8,p=1\$/);
    await expect(service.verify(password, hash)).resolves.toBe(true);
  });

  it('uses a different random salt for the same password', async () => {
    const [first, second] = await Promise.all([service.hash(password), service.hash(password)]);
    expect(first).not.toBe(second);
  });

  it('rejects the wrong password and weak passwords', async () => {
    const hash = await service.hash(password);
    await expect(service.verify('wrong-password-99', hash)).resolves.toBe(false);
    await expect(service.hash('short1')).rejects.toThrow(/12-256/);
  });
});
