declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    auth?: {
      sessionId: string;
      userId: string;
      email: string;
      role: 'superadmin' | 'user';
      mfaPassed: boolean;
    };
    agent?: {
      routerId: string;
      ownerId: string;
      product: string;
      status: string;
      agentVersion: string | null;
    };
  }
}

export {};
