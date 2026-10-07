/* SPDX-License-Identifier: GPL-2.0-or-later
 * Native reducer tests; synthetic painted pixels, no Quake/game data or audio.
 */
#include "qev_pixels.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

static unsigned char buffer[32 * 24], other[64 * 48];
static void begin(void) { assert(Qev_PixelsBegin(buffer, 32, 30, 24, 2, 2, 24, 16)); }
static void rect(int tag, int x, int y, int w, int h) {
    Qev_PixelsTag(tag);
    for (int row = y; row < y + h; row++) Qev_PixelsSpan(buffer + 32 * row + x, w);
}
static void painted(void) {
    begin(); rect(2, 10, 5, 8, 10); Qev_PixelsEnd();
    const qev_pixel_view_t *v = Qev_PixelsView(); const qev_pixel_object_t *o = &v->objects[2];
    assert(v->valid && v->x == 2 && v->y == 2 && v->width == 24 && v->height == 16);
    assert(o->count == 80 && o->left == 8 && o->right == 16 && o->top == 3 && o->bottom == 13 && o->at_aim && !o->clipped);
}
static void occlusion(void) {
    begin(); rect(2, 10, 5, 8, 10); rect(0, 10, 5, 8, 5); rect(3, 14, 10, 4, 5); Qev_PixelsEnd();
    const qev_pixel_view_t *v = Qev_PixelsView();
    assert(v->objects[2].count == 20 && v->objects[2].top == 8 && v->objects[2].right == 12 && !v->objects[2].at_aim);
    assert(v->objects[3].count == 20 && v->objects[3].at_aim);
    begin(); rect(2, 10, 5, 8, 10); rect(0, 10, 5, 8, 10); Qev_PixelsEnd();
    assert(!Qev_PixelsView()->objects[2].count); /* Completely hidden objects disappear. */
}
static void holes(void) {
    begin(); rect(2, 10, 5, 8, 10); Qev_PixelsTag(0); Qev_PixelsWrite(buffer + 10 * 32 + 14); Qev_PixelsEnd();
    const qev_pixel_object_t *o = &Qev_PixelsView()->objects[2];
    assert(o->count == 79 && !o->at_aim && o->left == 8 && o->right == 16);
}
static void clipping(void) {
    begin(); rect(2, 0, 0, 30, 24); Qev_PixelsEnd();
    const qev_pixel_object_t *o = &Qev_PixelsView()->objects[2];
    assert(o->count == 24 * 16 && o->left == 0 && o->right == 24 && o->bottom == 16 && o->clipped);
    begin(); rect(2, 28, 20, 2, 2); Qev_PixelsEnd(); assert(!Qev_PixelsView()->objects[2].count);
}
static void reset(void) {
    painted(); Qev_PixelsReset(); assert(!Qev_PixelsView()->valid && !Qev_PixelsView()->objects[2].count);
    begin(); Qev_PixelsTag(2); Qev_PixelsWrite(buffer + 6 * 32 + 6); Qev_PixelsWrite(buffer + 6 * 32 + 6); Qev_PixelsEnd();
    assert(Qev_PixelsView()->objects[2].count == 1); /* Count final pixels, not overdraw. */
    begin(); Qev_PixelsEnd(); assert(!Qev_PixelsView()->objects[2].count);
}
static void invalid(void) {
    painted();
    assert(!Qev_PixelsBegin(NULL, 32, 30, 24, 2, 2, 24, 16));
    assert(!Qev_PixelsBegin(buffer, 2, 30, 24, 2, 2, 24, 16));
    assert(!Qev_PixelsBegin(buffer, INT_MAX, INT_MAX, INT_MAX, 0, 0, 1, 1));
    assert(!Qev_PixelsBegin(buffer, 32, 30, 24, 2, 2, 30, 24));
    assert(!Qev_PixelsBegin(buffer, 32, 30, 24, -1, 2, 24, 16));
    assert(!Qev_PixelsView()->valid);
    begin(); Qev_PixelsTag(2);
    Qev_PixelsSpan(buffer + 10 * 32 + 5, -1); Qev_PixelsSpan(buffer + 10 * 32 + 5, 28);
    Qev_PixelsWrite(buffer + sizeof(buffer)); Qev_PixelsWrite(other);
    Qev_PixelsTag(QEV_PIXEL_TAGS); Qev_PixelsWrite(buffer + 10 * 32 + 14);
    Qev_PixelsTag(-1); Qev_PixelsWrite(buffer + 10 * 32 + 14);
    Qev_PixelsEnd(); assert(!Qev_PixelsView()->objects[2].count);
}
static void warp(void) {
    begin(); rect(2, 10, 5, 8, 10);
    assert(Qev_PixelsWarpBegin(other, 64, 60, 48, 4, 4, 48, 32));
    for (int y = 4; y < 36; y++) for (int x = 4; x < 52; x++)
        Qev_PixelsWarpCopy(other + y * 64 + x, buffer + (y / 2) * 32 + x / 2);
    Qev_PixelsWarpEnd(); Qev_PixelsEnd();
    const qev_pixel_view_t *v = Qev_PixelsView(); const qev_pixel_object_t *o = &v->objects[2];
    assert(v->valid && v->distorted && v->width == 48 && v->height == 32);
    assert(o->count == 320 && o->left == 16 && o->top == 6 && o->right == 32 && o->bottom == 26 && o->at_aim);
    begin(); assert(Qev_PixelsWarpBegin(other, 64, 60, 48, 4, 4, 48, 32)); Qev_PixelsEnd();
    assert(!Qev_PixelsView()->valid); /* Interrupted resampling cannot leak an old frame. */
    begin(); assert(!Qev_PixelsWarpBegin(other, 1, 60, 48, 4, 4, 48, 32)); assert(!qev_pixel_capture);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    if (!strcmp(argv[1], "painted")) painted();
    else if (!strcmp(argv[1], "occlusion")) occlusion();
    else if (!strcmp(argv[1], "holes")) holes();
    else if (!strcmp(argv[1], "clipping")) clipping();
    else if (!strcmp(argv[1], "reset")) reset();
    else if (!strcmp(argv[1], "invalid")) invalid();
    else if (!strcmp(argv[1], "warp")) warp();
    else return 2;
    puts("PASS"); return 0;
}
