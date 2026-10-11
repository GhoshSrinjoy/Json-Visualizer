#include <stdio.h>
#include "config.h"

#define BUF_SIZE 64
#define MIN(a, b) ((a) < (b) ? (a) : (b))

typedef struct {
    int id;
    char name[BUF_SIZE];
} Record;

enum Status { OK, FAILED };

static int counter = 0;

/* Parses one record and returns a status code. */
static int parse(const char* line, Record* out) {
    int n = 0;
    if (!line) goto fail;
    while (*line) {
        n++;
        line++;
    }
    out->id = n;
    counter += n;
    return OK;
fail:
    return FAILED;
}

int main(int argc, char** argv) {
    Record r;
    for (int i = 1; i < argc; i++) {
        switch (parse(argv[i], &r)) {
        case OK:
            printf("%d\n", r.id);
            break;
        default:
            return 1;
        }
    }
    return 0;
}
