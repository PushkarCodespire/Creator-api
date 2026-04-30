// ===========================================
// EXPRESS TYPE EXTENSIONS
// ===========================================
// Extend Express Request with custom properties
// This allows TypeScript to know about our custom user object

import { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: UserRole;
        creator?: { id: string } | null;
        company?: { id: string } | null;
      };
      guestId?: string; // For anonymous chat users
      io?: unknown; // Socket.io instance
    }
  }
}

// Make the global declaration available
export {};