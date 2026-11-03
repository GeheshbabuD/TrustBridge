import { getEnv } from "./env.js";

export class DatabaseLifecycleError extends Error {
  constructor(operation) {
    const safeMessages = {
      initialization: "Database client initialization failed",
      connection: "Database connection failed",
      disconnection: "Database disconnection failed",
    };

    super(safeMessages[operation] ?? "Database operation failed");
    this.name = "DatabaseLifecycleError";
    this.code = `DATABASE_${String(operation).toUpperCase()}_FAILED`;
  }
}

export const createDatabaseLifecycle = ({ createClient }) => {
  if (typeof createClient !== "function") {
    throw new TypeError("createClient must be a function");
  }

  let client;
  let clientPromise;
  let connectPromise;
  let disconnectPromise;

  const getClient = async () => {
    if (disconnectPromise) await disconnectPromise;
    if (client) return client;

    if (!clientPromise) {
      clientPromise = Promise.resolve()
        .then(createClient)
        .then((createdClient) => {
          if (
            !createdClient ||
            typeof createdClient.$connect !== "function" ||
            typeof createdClient.$disconnect !== "function"
          ) {
            throw new TypeError("Created client does not implement the Prisma lifecycle");
          }

          client = createdClient;
          return createdClient;
        })
        .catch(() => {
          clientPromise = undefined;
          throw new DatabaseLifecycleError("initialization");
        });
    }

    return clientPromise;
  };

  const connect = () => {
    if (connectPromise) return connectPromise;

    const attempt = (async () => {
      const currentClient = await getClient();
      try {
        await currentClient.$connect();
        return currentClient;
      } catch {
        try {
          await currentClient.$disconnect();
        } catch {
          // Keep connection failure details and credentials out of errors/logs.
        }

        if (client === currentClient) {
          client = undefined;
          clientPromise = undefined;
        }

        throw new DatabaseLifecycleError("connection");
      }
    })();

    connectPromise = attempt.catch((error) => {
      connectPromise = undefined;
      throw error;
    });
    return connectPromise;
  };

  const disconnect = () => {
    if (disconnectPromise) return disconnectPromise;

    const attempt = (async () => {
      if (connectPromise) {
        try {
          await connectPromise;
        } catch {
          // A failed connection attempt cleans up its client before rejecting.
        }
      }

      let currentClient = client;
      if (!currentClient && clientPromise) {
        try {
          currentClient = await clientPromise;
        } catch {
          return;
        }
      }
      if (!currentClient) return;

      try {
        await currentClient.$disconnect();
      } catch {
        throw new DatabaseLifecycleError("disconnection");
      }

      if (client === currentClient) {
        client = undefined;
        clientPromise = undefined;
        connectPromise = undefined;
      }
    })();

    disconnectPromise = attempt.finally(() => {
      disconnectPromise = undefined;
    });
    return disconnectPromise;
  };

  return Object.freeze({ getClient, connect, disconnect });
};

const createPrismaClient = async () => {
  const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
    import("../../generated/prisma/client.ts"),
    import("@prisma/adapter-pg"),
  ]);
  const adapter = new PrismaPg({ connectionString: getEnv().database.url });
  return new PrismaClient({ adapter });
};

const databaseLifecycle = createDatabaseLifecycle({ createClient: createPrismaClient });

export const getPrismaClient = () => databaseLifecycle.getClient();
export const connectDatabase = () => databaseLifecycle.connect();
export const disconnectDatabase = () => databaseLifecycle.disconnect();
