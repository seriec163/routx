export interface CollectedRoute {
  method: string;
  url: string;
  public: boolean;
}

const storage = new WeakMap<object, CollectedRoute[]>();

/**
 * Собирает маршруты при регистрации, чтобы из них можно было генерировать
 * OpenAPI-индекс без ручного списка.
 */
export function collectRoute(app: object, route: CollectedRoute): void {
  const list = storage.get(app) ?? [];
  list.push(route);
  storage.set(app, list);
}

export function collectedRoutes(app: object): CollectedRoute[] {
  return [...(storage.get(app) ?? [])];
}
