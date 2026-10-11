<?php
namespace App\Services;

use App\Models\User;
use App\Util\{Logger, Formatter};
require_once __DIR__ . '/helpers.php';

interface Loader { public function load(string $path): array; }

/** Loads users from disk. */
class UserLoader extends BaseLoader implements Loader
{
    use LogsTrait;

    const PREFIX = 'user:';
    private int $count = 0;

    public function __construct(private string $root) {}

    public function load(string $path, int $limit = 10): array
    {
        $result = [];
        if ($path === '') {
            throw new \InvalidArgumentException('path');
        } elseif (strlen($path) > 100) {
            return $result;
        } else {
            foreach ($this->read($path) as $item) {
                if ($item['disabled']) {
                    continue;
                }
                $result[] = new User($item['name']);
                if (count($result) >= $limit) {
                    break;
                }
            }
        }
        try {
            $this->validate($result);
        } catch (\Exception $e) {
            Logger::error($e->getMessage());
        } finally {
            $this->count++;
        }
        switch ($limit) {
            case 1:
                echo "one";
                break;
            default:
                echo "many";
        }
        for ($i = 0; $i < 3; $i++) { $this->count += $i; }
        while ($this->count > 0) { $this->count--; }
        $fn = fn($x) => $x + 1;
        return $result;
    }

    public static function describe(int $code): string
    {
        $label = '';
        switch ($code) {
            case 2:
            case 3:
                $label = 'few';
                break;
            default:
                $label = 'many';
        }
        do {
            $code--;
        } while ($code > 0);
        $wrap = function ($s) use ($label) { return "[$s] $label"; };
        return $wrap(self::PREFIX . $label);
    }

    private function validate(array $users): void {}
    private function read(string $p): array { return []; }
}

function helper($x) { return $x * 2; }
