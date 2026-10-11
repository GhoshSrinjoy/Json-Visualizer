#include <iostream>
#include <vector>
#include "util/log.h"
#include "models.hpp"

#define MAX_USERS 100
#define SQUARE(x) ((x) * (x))

namespace app {

enum class Role { Admin, Guest = 2 };

class User : public Base {
public:
    User(std::string name, int age) : name_(name), age_(age) {}
    std::string greet() const { return "hi " + name_; }
    void rename(const std::string& name);
    static int count;
private:
    std::string name_;
    int age_;
};

struct Point { int x; int y; };

/// Loads users from a file.
std::vector<User> loadUsers(const std::string& path, int limit) {
    std::vector<User> result;
    if (path.empty()) {
        throw std::runtime_error("empty");
    } else if (path.size() > 100) {
        return result;
    }
    for (int i = 0; i < limit; ++i) {
        if (i % 2 == 0) continue;
        User u("x", i);
        result.push_back(u);
        if (result.size() > 5) break;
    }
    for (auto& u : result) {
        log(u.greet());
    }
    try {
        validate(result);
    } catch (const std::exception& e) {
        log(e.what());
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
    int n = 0;
    while (n < 3) { n++; }
    do { n--; } while (n > 0);
    auto f = [](int x) { return x + 1; };
    return result;
}

void User::rename(const std::string& name) {
    this->name_ = name;
}

template <typename T>
T clamp(T value, T lo, T hi) {
    return value < lo ? lo : value > hi ? hi : value;
}

}  // namespace app

int main(int argc, char** argv) {
    auto users = app::loadUsers("a.txt", 10);
    return 0;
}
