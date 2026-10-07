/* SPDX-License-Identifier: GPL-2.0-or-later
 * Qev visible-pixel attribution/reduction. No world coordinates or depth inputs.
 * Tags are renderer-private; only visible extents/counts leave this module.
 */
#ifndef QEV_PIXELS_H
#define QEV_PIXELS_H
#include <stddef.h>

#define QEV_PIXEL_TAGS 1024
#define QEV_PIXEL_LIMIT (1280 * 1024)
typedef struct {
    int count, left, top, right, bottom, at_aim, clipped;
} qev_pixel_object_t;
typedef struct {
    int valid, x, y, width, height, distorted;
    qev_pixel_object_t objects[QEV_PIXEL_TAGS];
} qev_pixel_view_t;

extern int qev_pixel_capture;
void Qev_PixelsReset(void);
int Qev_PixelsBegin(const unsigned char *buffer, int stride, int width, int height,
    int x, int y, int view_width, int view_height);
void Qev_PixelsTag(int tag);
void Qev_PixelsWrite(const unsigned char *dest);
void Qev_PixelsSpan(const unsigned char *dest, int count);
int Qev_PixelsWarpBegin(const unsigned char *buffer, int stride, int width, int height,
    int x, int y, int view_width, int view_height);
void Qev_PixelsWarpCopy(const unsigned char *dest, const unsigned char *source);
void Qev_PixelsWarpEnd(void);
void Qev_PixelsEnd(void);
const qev_pixel_view_t *Qev_PixelsView(void);

/* Avoid calls in unsupported/disabled rendering paths. Writes follow the renderer's
 * ordinary opaque-fragment tests; the reducer never receives a Z value. */
#define QEV_PIXEL(dest) do { if (qev_pixel_capture) Qev_PixelsWrite(dest); } while (0)
#endif
