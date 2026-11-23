import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Ловит ошибки рендера, чтобы падение одной страницы не оставляло пустой экран.
 * Перезагрузка возвращает к нормальному состоянию без потери сессии.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot">
          <div className="boot-card">
            <h2>Что-то пошло не так</h2>
            <p className="muted-text">{this.state.error.message}</p>
            <div className="row" style={{ marginTop: 12 }}>
              <Button onClick={() => window.location.reload()}>Перезагрузить</Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
