import React from 'react';
import { Badge, Button, Popover, Tooltip } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { NOTIFICATION_TITLE, groupNotifications, hypothesesCountIn, useMarkRead, useNotifications } from '@/api/notifications';
import type { ApiNotification } from '@/api/notifications';
import { formatDateTime } from '@/api/protocols';
import { useAuth } from '@/app/providers/useAuth';
import { useProjects } from '@/app/providers/useProjects';
import './Compare.css';

/**
 * Колокольчик в шапке: уведомления сервера; о готовом протоколе — переходы к протоколу, кандидатам и гипотезам; о неудачной передаче — к протоколу, где её можно повторить.
 * У администратора страница «Верификация» подменена разбором для дообучения и не умеет открывать произвольный объект по кандидатам/гипотезам
 * (уводит на первый проект с ожидающими записями или на дашборд) — поэтому у него только переходы, которые ведут туда, куда он действительно попадёт: протокол.
 * Загрузку администратор не делает (её нет в его меню), поэтому «К пакетам» (страница «Интеграция») показываем только инспектору и руководителю.
 */
export const NotificationsBell: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [open, setOpen] = React.useState(false);
  const query = useNotifications(enabled, user?.role);
  const markRead = useMarkRead();
  const { projects } = useProjects();
  const projectNames = React.useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const items = React.useMemo(() => query.data ?? [], [query.data]);
  const unread = items.filter((n) => !n.is_read);
  const groups = React.useMemo(() => groupNotifications(items), [items]);

  const canOpenPackages = user?.role === 'INSPECTOR' || user?.role === 'SUPERVISOR';

  const go = (n: ApiNotification, target: 'protocol' | 'findings' | 'hypotheses' | 'packages', readIds: string[]) => {
    setOpen(false);
    if (readIds.length > 0) void markRead(readIds);
    // Пакет из внешней ИС: проверку из него создают на странице «Интеграция», там же видно, почему он отложен
    if (target === 'packages') {
      navigate('/integration');
      return;
    }
    if (!n.object_id) return;
    else if (target === 'protocol' || isAdmin) navigate(`/protocol?object=${n.object_id}`);
    else navigate(`/verification?object=${n.object_id}${target === 'hypotheses' ? '&view=hypotheses' : ''}`);
  };

  // Записи для дообучения администратор разбирает на своём дашборде
  const goDashboard = (readIds: string[]) => {
    setOpen(false);
    if (readIds.length > 0) void markRead(readIds);
    navigate('/dashboard');
  };

  const content = (
    <div className="notif-list">
      <div className="notif-head">
        <b>Уведомления</b>
        {unread.length > 0 && (
          <Button size="small" type="link" onClick={() => void markRead(unread.map((n) => n.id))}>
            Прочитать все
          </Button>
        )}
      </div>
      {query.isError && <div className="notif-empty">Не удалось загрузить уведомления.</div>}
      {!query.isError && items.length === 0 && <div className="notif-empty">Уведомлений нет.</div>}
      {groups.slice(0, 20).map((group) => {
        const n = group.latest;
        const projectName = n.object_id ? projectNames.get(n.object_id) : undefined;
        const hypotheses = n.type === 'PROTOCOL_READY' ? hypothesesCountIn(n.message) : 0;
        return (
          <div key={n.id} className={`notif-item${group.unreadIds.length > 0 ? ' is-unread' : ''}`}>
            <div className="notif-title">
              <span>
                {NOTIFICATION_TITLE[n.type]}
                {group.count > 1 && <span className="notif-count"> ×{group.count}</span>}
              </span>
              <span className="notif-time">{formatDateTime(n.created_at)}</span>
            </div>
            {projectName && <div className="notif-project">{projectName}</div>}
            <div className="notif-text">{n.message}</div>
            {n.type === 'RETRAIN_ITEM_PENDING' && isAdmin && (
              <div className="notif-actions">
                <Button size="small" onClick={() => goDashboard(group.unreadIds)}>
                  К записям
                </Button>
              </div>
            )}
            {n.object_id && (
              <div className="notif-actions">
                {n.type === 'PROTOCOL_READY' && (
                  <>
                    <Button size="small" onClick={() => go(n, 'protocol', group.unreadIds)}>
                      К протоколу
                    </Button>
                    {!isAdmin && (
                      <Button size="small" onClick={() => go(n, 'findings', group.unreadIds)}>
                        К кандидатам
                      </Button>
                    )}
                    {!isAdmin && hypotheses > 0 && (
                      <Button size="small" onClick={() => go(n, 'hypotheses', group.unreadIds)}>
                        К гипотезам
                      </Button>
                    )}
                  </>
                )}
                {n.type === 'NEW_DOCUMENTS_AVAILABLE' && canOpenPackages && (
                  <Button size="small" onClick={() => go(n, 'packages', group.unreadIds)}>
                    К пакетам
                  </Button>
                )}
                {n.type === 'UNFINALIZE_REQUESTED' && (
                  <Button size="small" onClick={() => go(n, 'protocol', group.unreadIds)}>
                    К запросу
                  </Button>
                )}
                {n.type === 'SYNC_FAILED' && (
                  <Button size="small" onClick={() => go(n, 'protocol', group.unreadIds)}>
                    К передаче
                  </Button>
                )}
                {(n.type === 'PROCESS_FAILED' || n.type === 'ADMIN_ALERT') && (
                  <Button size="small" onClick={() => go(n, 'findings', group.unreadIds)}>
                    Открыть проект
                  </Button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <Popover content={content} trigger="click" open={open} onOpenChange={setOpen} placement="bottomRight" arrow={false} overlayClassName="notif-popover">
      <Tooltip title="Уведомления">
        <Badge count={unread.length} size="small" overflowCount={99}>
          <Button className="notif-btn" type="text" icon={<BellOutlined />} aria-label="Уведомления" />
        </Badge>
      </Tooltip>
    </Popover>
  );
};
