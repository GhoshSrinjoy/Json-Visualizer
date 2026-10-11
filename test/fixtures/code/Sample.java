package com.example.app;

import java.util.List;
import java.util.ArrayList;
import static java.lang.Math.max;
import com.example.util.*;

public class Sample extends Base implements Runnable {
    private int count = 0;

    public Sample(int count) {
        this.count = count;
    }

    @Override
    public void run() {
        System.out.println("run");
    }

    public List<String> load(String path, int limit) throws Exception {
        List<String> result = new ArrayList<>();
        if (path == null) {
            throw new IllegalArgumentException("path");
        } else if (path.isEmpty()) {
            return result;
        }
        for (int i = 0; i < limit; i++) {
            if (i % 2 == 0) continue;
            result.add(String.valueOf(i));
            if (result.size() > 5) break;
        }
        for (String s : result) {
            log(s);
        }
        try {
            validate(result);
        } catch (IllegalStateException | NullPointerException e) {
            log(e.getMessage());
        } finally {
            count = max(count, result.size());
        }
        switch (limit) {
            case 1:
                log("one");
                break;
            case 2:
            case 3:
                log("few");
            default:
                log("many");
        }
        while (count > 0) { count--; }
        do { count++; } while (count < 3);
        Runnable r = () -> log("lambda");
        return result;
    }

    private static void log(String s) { System.out.println(s); }
    private void validate(List<String> xs) {}

    interface Callback { void done(); }
    enum Mode { A, B }
}
