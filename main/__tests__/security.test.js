import { describe, it, expect } from 'vitest';

describe('Security', () => {
  describe('hashPassword', () => {
    it('returns a salted hash different from the plaintext', async () => {
      const { hashPassword } = await import('../security.js');
      const stored = hashPassword('admin');
      expect(stored).toContain('$');
      expect(stored).not.toBe('admin');
    });

    it('produces unique salts for the same password', async () => {
      const { hashPassword } = await import('../security.js');
      expect(hashPassword('admin')).not.toBe(hashPassword('admin'));
    });
  });

  describe('verifyPassword', () => {
    it('accepts the correct password', async () => {
      const { hashPassword, verifyPassword } = await import('../security.js');
      const stored = hashPassword('admin');
      expect(verifyPassword('admin', stored)).toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const { hashPassword, verifyPassword } = await import('../security.js');
      const stored = hashPassword('admin');
      expect(verifyPassword('wrong', stored)).toBe(false);
    });

    it('rejects passwords with special characters only when mismatched', async () => {
      const { hashPassword, verifyPassword } = await import('../security.js');
      const stored = hashPassword('p@ss w0rd!');
      expect(verifyPassword('p@ss w0rd!', stored)).toBe(true);
      expect(verifyPassword('p@ss w0rd', stored)).toBe(false);
    });

    it('returns false for empty or malformed stored values', async () => {
      const { verifyPassword } = await import('../security.js');
      expect(verifyPassword('admin', '')).toBe(false);
      expect(verifyPassword('admin', 'plaintext')).toBe(false);
      expect(verifyPassword('admin', null)).toBe(false);
    });
  });
});
