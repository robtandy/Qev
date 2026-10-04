/* SPDX-License-Identifier: GPL-2.0-or-later
 * Qev's narrow bridge, 2026-10-04; included after Quake's engine type definitions.
 * See COPYING and README.md for license, source, and modification notices.
 */
#ifndef QEV_BRIDGE_H
#define QEV_BRIDGE_H
void Qev_MainLoop(void);
void Qev_PreRender(void);
int Qev_OwnsInput(void);
void Qev_ApplyInput(usercmd_t *cmd);
void Qev_ClearKeys(void);
void Qev_Attack(int down);
void Qev_WorldChanged(void);
void Qev_EntityFreed(edict_t *ed);
#endif
